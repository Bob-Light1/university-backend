'use strict';

/**
 * @file gaet.queue.js
 * @description Bounded job queue for GAET timetable generation.
 *
 *  Problem it solves
 *  ─────────────────────────────────────────────────────────────────────────────
 *  Each POST /api/gaet/generate spawns a CPU-bound worker_thread. The per-user
 *  rate limiter (strictLimiter: 3/h) does NOT bound the number of *concurrent*
 *  workers across all campuses. A burst of generations could spawn dozens of
 *  threads at once and saturate the CPU. This module enforces a global cap on
 *  simultaneous generation workers and queues the surplus.
 *
 *  Two interchangeable backends (selected at boot)
 *  ─────────────────────────────────────────────────────────────────────────────
 *  • REDIS_URL set   → BullMQ-backed queue: distributed, survives restarts,
 *                      shared across multiple app instances. Concurrency is
 *                      enforced by the BullMQ Worker (`concurrency` option).
 *  • REDIS_URL unset → in-process queue: a semaphore + FIFO waiting list inside
 *                      this Node process. Zero infrastructure, ideal for dev and
 *                      single-instance free-tier deployments. Queued jobs are lost
 *                      on restart but recovered to FAILED by the boot-time zombie
 *                      sweep (gaet.service.recoverZombieJobs).
 *
 *  Switching to the distributed backend is a deployment concern only: set
 *  REDIS_URL — no controller change required.
 *
 *  Concurrency cap: GAET_MAX_CONCURRENCY env (default 2).
 *
 *  The constraint is already atomically marked GENERATING by the controller
 *  (gaetRepo.claimForGeneration) BEFORE enqueueing, so a queued job and a running
 *  job share the GENERATING status — which keeps the 7-state machine intact.
 */

const path           = require('path');
const { Worker: ThreadWorker } = require('worker_threads');

const gaetRepo = require('./gaet.repository');

const MAX_CONCURRENCY = Math.max(1, parseInt(process.env.GAET_MAX_CONCURRENCY, 10) || 2);
const QUEUE_NAME      = 'gaet-generation';
const WORKER_PATH     = path.join(__dirname, 'gaet.engine.worker.js');

// ─────────────────────────────────────────────
// CORE — worker_thread runner + job processor (backend-agnostic)
// ─────────────────────────────────────────────

/**
 * Runs the CPU-bound generation engine in an isolated worker_thread and resolves
 * with its result message. Rejects on runtime error or non-zero exit.
 *
 * @param {string} constraintId
 * @returns {Promise<{status: string, sessions: Array, report: Object}>}
 */
function runGenerationWorker(constraintId) {
  return new Promise((resolve, reject) => {
    const thread = new ThreadWorker(WORKER_PATH, { workerData: { constraintId } });
    let settled  = false;

    thread.on('message', (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    });

    thread.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    thread.on('exit', (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Generation worker exited with code ${code}`));
    });
  });
}

/**
 * Processes one generation job: run the engine, persist the result.
 * Shared by both backends. Never throws — failures are persisted as FAILED.
 *
 * @param {{ constraintId: string, actorId: string, generationVersion: number }} payload
 */
async function processGenerationJob({ constraintId, actorId, generationVersion }) {
  try {
    const result = await runGenerationWorker(constraintId);
    await gaetRepo.applyWorkerResult(constraintId, {
      status:            result.status,
      sessions:          result.sessions,
      report:            result.report,
      generatedBy:       actorId,
      generationVersion,
    });
  } catch (err) {
    console.error(`[GAET] Generation job failed (constraint ${constraintId}):`, err.message);
    try {
      await gaetRepo.markFailed(constraintId);
    } catch (persistErr) {
      console.error('[GAET] Failed to mark constraint as FAILED:', persistErr.message);
    }
  }
}

// ─────────────────────────────────────────────
// BACKEND SELECTION
// ─────────────────────────────────────────────

let enqueueImpl;   // (payload) => Promise<void>
let shutdownImpl;  // () => Promise<void>

if (process.env.REDIS_URL) {
  // ── BullMQ backend ────────────────────────────────────────────────────────
  // Lazy-required so the in-process path never needs bullmq/ioredis installed.
  const { Queue, Worker: QueueWorker } = require('bullmq');
  const IORedis = require('ioredis');

  // BullMQ requires maxRetriesPerRequest = null on the shared connection.
  const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });

  const queue = new Queue(QUEUE_NAME, { connection });

  const worker = new QueueWorker(
    QUEUE_NAME,
    async (job) => processGenerationJob(job.data),
    { connection, concurrency: MAX_CONCURRENCY },
  );

  worker.on('failed', (job, err) => {
    console.error(`[GAET] BullMQ job ${job?.id} failed:`, err?.message);
  });

  enqueueImpl = (payload) =>
    queue.add('generate', payload, {
      removeOnComplete: true,
      removeOnFail:     100, // keep the last 100 failures for inspection
    });

  shutdownImpl = async () => {
    await Promise.all([worker.close(), queue.close()]).catch(() => {});
    connection.disconnect();
  };

  console.log(`✅ [GAET] Generation queue: BullMQ (Redis) — concurrency ${MAX_CONCURRENCY}.`);
} else {
  // ── In-process backend ────────────────────────────────────────────────────
  const waiting = []; // FIFO list of pending payloads
  let active    = 0;

  const drain = () => {
    while (active < MAX_CONCURRENCY && waiting.length > 0) {
      const payload = waiting.shift();
      active += 1;
      // processGenerationJob never throws, but guard the slot release regardless.
      processGenerationJob(payload).finally(() => {
        active -= 1;
        drain();
      });
    }
  };

  enqueueImpl = (payload) => {
    waiting.push(payload);
    drain();
    return Promise.resolve();
  };

  shutdownImpl = () => Promise.resolve();

  console.log(`✅ [GAET] Generation queue: in-process — concurrency ${MAX_CONCURRENCY}.`);
}

// ─────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────

/**
 * Enqueues a generation job. The job is processed as soon as a concurrency slot
 * is free. The constraint must already be in GENERATING status (claimed by the
 * controller) before calling this.
 *
 * @param {{ constraintId: string, actorId: string, generationVersion: number }} payload
 * @returns {Promise<void>}
 */
const enqueueGeneration = (payload) => enqueueImpl(payload);

/**
 * Gracefully closes queue/worker connections (called from server.js shutdown).
 * @returns {Promise<void>}
 */
const shutdownQueue = () => shutdownImpl();

module.exports = {
  enqueueGeneration,
  shutdownQueue,
  MAX_CONCURRENCY,
};
