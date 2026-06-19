/**
 * @file index.js — FAÇADE du module department
 * Single public entry point for the module — see MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * Academic departments. Mounted on /api/department.
 */

const routes  = require('./department.routes');
const service = require('./department.service');

module.exports = {
  routes,   // mounted by server.js: app.use('/api/department', routes)
  service,  // inter-module API (empty for now — see department.service.js)
  // No model exported. No controller exported.
};
