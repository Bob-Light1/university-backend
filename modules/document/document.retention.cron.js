'use strict';

/**
 * @file document.retention.cron.js
 * @description Weekly cron job that enforces document retention policies.
 *
 * Finds all documents whose retentionUntil date has passed, soft-deletes them,
 * and writes a system audit entry for each.
 *
 * ADMIN users are notified of all retention-triggered deletions via the event system.
 *
 * Schedule: every Sunday at 02:00 UTC. Registered — like all eight background
 * jobs — by `shared/lib/register-jobs.js`, which owns the schedule, the timezone
 * and the per-job failure guard. Do not call `cron.schedule` from here.
 */

const repo = require('./document.repository');
// lazy require (at job time): academic-print consumes the document facade
// (generateQrCodeDataUrl) — a require at load time would create a
// document ↔ academic-print cycle and a partially initialized facade.
const cleanupExpiredPrintFiles = (...args) =>
  require('../academic-print').service.cleanupExpiredPrintFiles(...args);

const BATCH_SIZE = 100;

/**
 * Defensive ceiling on the number of batches, as in finance.service.js. It is not a
 * pagination bound: reaching it means the candidate set is not draining, which is a
 * bug in this job rather than a large backlog.
 */
const MAX_BATCHES = 1000;

/** Documents whose retention has expired and that are not already soft-deleted. */
const expiredFilter = () => ({
  retentionUntil: { $ne: null, $lte: new Date() },
  deletedAt:      null,
});

/**
 * Runs the retention enforcement job.
 * Soft-deletes all documents whose retentionUntil has passed and are not already deleted.
 * Processes in batches to avoid memory pressure.
 *
 * The candidate set is self-draining — soft-deleting a document removes it from the
 * filter — so every batch is the same query with no offset. Termination comes from the
 * set emptying, backed by two guards: a batch in which nothing succeeded would be
 * re-fetched identically forever, and MAX_BATCHES catches a set that never drains.
 *
 * @returns {Promise<{ processed: number, errors: number, remaining: number }>}
 */
const runRetentionJob = async () => {
  console.log('[RetentionCron] Starting document retention enforcement job...');

  let processed = 0;
  let errors    = 0;
  let batches   = 0;
  let stalled   = false;

  while (batches < MAX_BATCHES) {
    const expired = await repo.findExpiredDocuments(expiredFilter(), { limit: BATCH_SIZE });

    if (expired.length === 0) break;

    batches += 1;
    let succeededThisBatch = 0;

    for (const doc of expired) {
      try {
        await repo.updateDocumentById(doc._id, {
          deletedAt: new Date(),
          deletedBy: { userId: null, userModel: 'System' },
        });

        await repo.createAudit({
          documentId:  doc._id,
          campusId:    doc.campusId,
          action:      'DELETE',
          performedBy: null,
          userModel:   'System',
          performedAt: new Date(),
          reason:      `Retention policy expired (${doc.retentionPolicy}) — retentionUntil: ${doc.retentionUntil?.toISOString()}`,
          metadata:    { retentionPolicy: doc.retentionPolicy, ref: doc.ref, triggeredBy: 'retention-cron' },
        });

        processed++;
        succeededThisBatch++;
      } catch (err) {
        console.error(`[RetentionCron] Error processing document ${doc._id}:`, err.message);
        errors++;
      }
    }

    // Nothing left the candidate set, so the next fetch returns the identical batch.
    // A short all-failing batch is a stuck set, not a drained one — reporting it as
    // drained would be the same lie as the offset bug this loop replaced.
    if (succeededThisBatch === 0) {
      stalled = true;
      break;
    }

    // A short batch means nothing else matches — the set is exhausted. Checked
    // AFTER the progress guard, so a short batch in which everything failed is
    // reported as stuck rather than as drained.
    if (expired.length < BATCH_SIZE) break;
  }

  // Report the goal, not just the effort: a job can only report what it did, and
  // that is exactly why a half-drained backlog went unnoticed for so long.
  const remaining = await repo.countExpiredDocuments(expiredFilter());

  console.log(
    `[RetentionCron] Completed. Processed: ${processed}, Errors: ${errors}, Still expired: ${remaining}`,
  );

  if (stalled || batches >= MAX_BATCHES) {
    console.error(
      `[RetentionCron] Aborted early after ${batches} batch(es) — the candidate set is not draining.`,
    );
  }

  // Also purge expired academic print PDFs (30-day TTL)
  try {
    const removed = await cleanupExpiredPrintFiles(30);
    if (removed > 0) console.log(`[RetentionCron] Removed ${removed} expired print PDF(s).`);
  } catch (err) {
    console.error('[RetentionCron] Print cleanup error:', err.message);
  }

  return { processed, errors, remaining };
};

module.exports = { runRetentionJob };