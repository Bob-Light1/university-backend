/**
 * @file index.js — FAÇADE du module campus
 * Single public entry point for the module — see MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * Campus (core): CRUD, manager dashboard, campus login, preferences.
 * The dashboard consumes the finance/mentor/settings/staff facades.
 * Mounted on /api/campus.
 */

const routes  = require('./campus.routes');
const service = require('./campus.service');

module.exports = {
  routes,   // mounted by server.js: app.use('/api/campus', routes)
  service,  // inter-module API (empty for now — see campus.service.js)
  // No model exported. No controller exported.
};
