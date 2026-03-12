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
 * Schedule: weekly (configure via node-cron in server.js)
 * Usage in server.js:
 *   const cron = require('node-cron');
 *   const { runRetentionJob } = require('./modules/document/document.retention.cron');
 *   cron.schedule('0 2 * * 0', runRetentionJob); // Every Sunday at 02:00
 */

const Document      = require('./models/document.model');
const DocumentAudit = require('./models/documentAudit.model');

const BATCH_SIZE = 100;

/**
 * Runs the retention enforcement job.
 * Soft-deletes all documents whose retentionUntil has passed and are not already deleted.
 * Processes in batches to avoid memory pressure.
 *
 * @returns {Promise<{ processed: number, errors: number }>}
 */
const runRetentionJob = async () => {
  console.log('[RetentionCron] Starting document retention enforcement job...');

  let processed = 0;
  let errors    = 0;
  let skip      = 0;
  let hasMore   = true;

  while (hasMore) {
    const expired = await Document.find({
      retentionUntil: { $ne: null, $lte: new Date() },
      deletedAt:      null,
    })
      .select('_id campusId ref retentionPolicy retentionUntil')
      .skip(skip)
      .limit(BATCH_SIZE)
      .lean();

    if (expired.length === 0) {
      hasMore = false;
      break;
    }

    for (const doc of expired) {
      try {
        await Document.findByIdAndUpdate(doc._id, {
          deletedAt: new Date(),
          deletedBy: { userId: null, userModel: 'System' },
        });

        await DocumentAudit.create({
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
      } catch (err) {
        console.error(`[RetentionCron] Error processing document ${doc._id}:`, err.message);
        errors++;
      }
    }

    skip    += expired.length;
    hasMore  = expired.length === BATCH_SIZE;
  }

  console.log(`[RetentionCron] Completed. Processed: ${processed}, Errors: ${errors}`);
  return { processed, errors };
};

module.exports = { runRetentionJob };