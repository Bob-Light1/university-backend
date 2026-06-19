/**
 * @file index.js — FACADE of the academic-print module
 * The module's only public entry point — see MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * Academic prints (PDF): class lists, timetables, transcripts — Puppeteer + QR
 * generation. Mounted on /api/print.
 *
 * Batch jobs are persisted (PrintJob model) and processed by a queue worker
 * (atomic claim) → status/downloads reachable from any process.
 */

const routes  = require('./academic-print.routes');
const service = require('./academic-print.service');

module.exports = {
  routes,   // mounted by server.js :  app.use('/api/print', routes)
  service,  // { shutdownAcademicPool, cleanupExpiredPrintFiles, runPrintQueueJob }
  // NO model exported. NO controller exported.
};
