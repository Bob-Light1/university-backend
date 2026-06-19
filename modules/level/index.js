/**
 * @file index.js — FAÇADE du module level
 * Single public entry point for the module — see MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * Academic levels. Mounted on /api/level.
 */

const routes  = require('./level.routes');
const service = require('./level.service');

module.exports = {
  routes,   // mounted by server.js: app.use('/api/level', routes)
  service,  // inter-module API (empty for now — see level.service.js)
  // No model exported. No controller exported.
};
