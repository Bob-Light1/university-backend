'use strict';

/**
 * @file academic-print.service.js — inter-module API of the academic-print domain (facade).
 *
 * Current consumers:
 *   - server.js : shutdownAcademicPool (graceful Puppeteer pool shutdown)
 *   - server.js (cron) : runPrintQueueJob (sweep the persisted print job queue)
 *   - modules/document (retention cron) : cleanupExpiredPrintFiles
 */

const { shutdownAcademicPool, cleanupExpiredPrintFiles } = require('./academic-pdf.service');
const { runPrintQueueJob } = require('./print-job.processor');

module.exports = {
  shutdownAcademicPool,
  cleanupExpiredPrintFiles,
  runPrintQueueJob,
};
