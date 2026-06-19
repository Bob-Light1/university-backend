'use strict';

/**
 * @file print-job.repository.js — persistence layer for batch print jobs.
 *
 * The ONLY file allowed to touch the PrintJob model. The controller (enqueue +
 * reads) and the processor (claim + progress + finalize + sweep) go through it.
 * Status mutations are atomic operators — no business hooks to preserve.
 */

const PrintJob = require('./models/print-job.model');

// ── Writes ──────────────────────────────────────────────────────────────────

const create = (doc) => PrintJob.create(doc);

/**
 * Atomically claim a PENDING job (→ PROCESSING). Returns the claimed job, or
 * null if another worker already took it. Guarantees single-worker processing.
 */
const claim = (jobId) =>
  PrintJob.findOneAndUpdate(
    { _id: jobId, status: 'PENDING' },
    { $set: { status: 'PROCESSING', startedAt: new Date(), workerClaimedAt: new Date() } },
    { new: true }
  ).lean();

const pushSuccess = (jobId, result) =>
  PrintJob.updateOne(
    { _id: jobId },
    { $push: { results: result }, $inc: { 'progress.done': 1 } }
  );

const pushFailure = (jobId, result) =>
  PrintJob.updateOne(
    { _id: jobId },
    { $push: { results: result }, $inc: { 'progress.done': 1, 'progress.failed': 1 } }
  );

const finalize = (jobId, status) =>
  PrintJob.updateOne({ _id: jobId }, { $set: { status, completedAt: new Date() } });

// ── Reads ───────────────────────────────────────────────────────────────────

const findByIdLean = (jobId) => PrintJob.findById(jobId).lean();

/**
 * Heartbeat: refresh `workerClaimedAt` while a job is being processed, so a long
 * batch is never mistaken for a dead worker and requeued mid-flight. Returns the
 * (status-only) doc if still PROCESSING, or null if it was cancelled/deleted/done
 * — which doubles as the worker's cancellation/stop signal.
 */
const touchProcessing = (jobId) =>
  PrintJob.findOneAndUpdate(
    { _id: jobId, status: 'PROCESSING' },
    { $set: { workerClaimedAt: new Date() } },
    { new: true }
  ).select('status').lean();

/**
 * Campus job history (paginated, most recent first). `campusId` null/undefined
 * (ADMIN/DIRECTOR with no scope) returns all campuses' jobs.
 */
const paginateForCampus = async ({ campusId, skip = 0, limit = 20 }) => {
  const filter = campusId ? { campusId } : {};
  const [data, total] = await Promise.all([
    PrintJob.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('type status progress params startedAt completedAt createdAt')
      .lean(),
    PrintJob.countDocuments(filter),
  ]);
  return { data, total };
};

// ── Queue worker (sweep) ──────────────────────────────────────────────────────

/** IDs of jobs still waiting to be processed (oldest first). */
const findClaimablePendingIds = (limit = 20) =>
  PrintJob.find({ status: 'PENDING' })
    .sort({ createdAt: 1 })
    .limit(limit)
    .select('_id')
    .lean();

/** Requeue PROCESSING jobs whose worker likely died (claimed before `staleBefore`). */
const requeueStale = (staleBefore) =>
  PrintJob.updateMany(
    { status: 'PROCESSING', workerClaimedAt: { $lt: staleBefore } },
    { $set: { status: 'PENDING', workerClaimedAt: null } }
  );

module.exports = {
  create,
  claim,
  pushSuccess,
  pushFailure,
  finalize,
  findByIdLean,
  touchProcessing,
  paginateForCampus,
  findClaimablePendingIds,
  requeueStale,
};
