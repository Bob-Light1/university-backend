'use strict';

/**
 * @file public-portal.queue.js
 * @description Ingestion buffer for the public write endpoints (pre-registration
 * leads, session alerts, contact messages).
 *
 *  Problem it solves
 *  ─────────────────────────────────────────────────────────────────────────────
 *  pre-register / alert / contact write into the same MongoDB that serves the
 *  core ERP (students, exams, schedules…). A viral quiz or a marketing campaign
 *  can produce write bursts that contend with core load. This module puts a
 *  buffer between the public portal and the core write path, so a public spike
 *  degrades the portal's own ingestion latency rather than starving the ERP.
 *
 *  Two interchangeable backends (selected at boot — same REDIS_URL switch as
 *  modules/gaet/gaet.queue.js)
 *  ─────────────────────────────────────────────────────────────────────────────
 *  • REDIS_URL set   → BullMQ queue + worker: durable, distributed, processed off
 *                      the request path with bounded concurrency and retries. The
 *                      controller responds 202 immediately after enqueue.
 *  • REDIS_URL unset → inline synchronous execution. Buffering brings no benefit
 *                      on a single instance (no peer to offload to) and an
 *                      in-memory buffer would LOSE leads on restart — unacceptable
 *                      for a lead. So the write runs inline and is awaited:
 *                      identical durability to a direct call, behind the same
 *                      enqueue() surface.
 *
 *  Synchronous input validation and partner/campus resolution stay in the
 *  controllers (a visitor must be told immediately about a bad referral code or a
 *  missing field). Only the persistence write — dedup, IP_BURST detection,
 *  insert — is deferred here, and it runs the very same partner service /
 *  repository methods, so there is no business-logic duplication.
 *
 *  Concurrency cap: PUBLIC_INGESTION_CONCURRENCY env (default 5).
 */

const QUEUE_NAME  = 'public-portal-ingestion';
const CONCURRENCY = Math.max(1, parseInt(process.env.PUBLIC_INGESTION_CONCURRENCY, 10) || 5);

// Lazy facades — resolved at call time to avoid boot-order coupling and to keep
// the in-process path free of any queue dependency.
const partnerService = () => require('../partner').service;
const repo           = () => require('./public-portal.repository');

// ─────────────────────────────────────────────
// CORE — job processor (backend-agnostic)
// ─────────────────────────────────────────────

/**
 * Dispatches one ingestion job to the matching service / repository method.
 * Throws on failure — BullMQ retries on a thrown error; the inline path
 * propagates it to the controller (asyncHandler → 500), matching prior behavior.
 *
 * @param {{ type: 'pre-register'|'alert'|'contact', payload: Object }} job
 * @returns {Promise<*>}
 */
async function processIngestionJob({ type, payload }) {
  switch (type) {
    case 'pre-register': {
      // partnerId travels as a primitive; the partner service only reads
      // partner._id, so a minimal stand-in object is sufficient.
      const { partnerId, ...rest } = payload;
      return partnerService().upsertPreRegistrationLead({
        ...rest,
        partner: partnerId ? { _id: partnerId } : null,
      });
    }
    case 'alert':
      return partnerService().registerSessionAlert(payload);
    case 'contact':
      return repo().createContactMessage(payload);
    default:
      throw new Error(`Unknown ingestion job type: ${type}`);
  }
}

// ─────────────────────────────────────────────
// BACKEND SELECTION
// ─────────────────────────────────────────────

let enqueueImpl;   // (job) => Promise<void>
let shutdownImpl;  // () => Promise<void>

if (process.env.REDIS_URL) {
  // ── BullMQ backend ──────────────────────────────────────────────────────────
  // Lazy-required so the in-process path never needs bullmq/ioredis installed.
  const { Queue, Worker } = require('bullmq');
  const IORedis = require('ioredis');

  // BullMQ requires maxRetriesPerRequest = null on the shared connection.
  const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });

  const queue = new Queue(QUEUE_NAME, { connection });

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => processIngestionJob(job.data),
    { connection, concurrency: CONCURRENCY },
  );

  worker.on('failed', (job, err) => {
    console.error(`[public-portal] ingestion job ${job?.id} (${job?.data?.type}) failed:`, err?.message);
  });

  enqueueImpl = (job) =>
    queue.add(job.type, job, {
      attempts: 5,
      backoff:  { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail:     500, // keep the last 500 failures for inspection
    });

  shutdownImpl = async () => {
    await Promise.all([worker.close(), queue.close()]).catch(() => {});
    connection.disconnect();
  };

  console.log(`✅ [public-portal] Ingestion queue: BullMQ (Redis) — concurrency ${CONCURRENCY}.`);
} else {
  // ── Inline backend ────────────────────────────────────────────────────────
  // Synchronous, durable, no buffering (see file header).
  enqueueImpl  = (job) => processIngestionJob(job);
  shutdownImpl = () => Promise.resolve();

  console.log('ℹ️  [public-portal] Ingestion: inline (synchronous). Set REDIS_URL to buffer via BullMQ.');
}

// ─────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────

/**
 * Enqueues a public ingestion job. With Redis the write is deferred and this
 * resolves once the job is queued; without Redis the write runs inline and this
 * resolves once it is persisted. Either way the controller responds 202 after a
 * successful resolution of this promise.
 *
 * @param {{ type: 'pre-register'|'alert'|'contact', payload: Object }} job
 * @returns {Promise<void>}
 */
const enqueueIngestion = (job) => Promise.resolve(enqueueImpl(job)).then(() => undefined);

/**
 * Gracefully closes queue/worker connections (called from server.js shutdown).
 * @returns {Promise<void>}
 */
const shutdownIngestionQueue = () => shutdownImpl();

module.exports = {
  enqueueIngestion,
  shutdownIngestionQueue,
};
