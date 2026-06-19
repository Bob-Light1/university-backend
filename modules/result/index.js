/**
 * @file index.js — FACADE of the result module
 * Only public entry point of the module — see MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * Grades/results, validation workflow, analytics, final transcripts
 * (FinalTranscript) and grading scales (GradingScale). Mounted on /api/results.
 */

const routes  = require('./result.routes');
const service = require('./result.service');

module.exports = {
  routes,   // mounted by server.js:  app.use('/api/results', routes)
  service,  // inter-module API (empty for now — see result.service.js)
  // NO model exported. NO controller exported.
};
