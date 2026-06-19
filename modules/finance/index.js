/**
 * @file index.js — FACADE of the finance module
 * Sole public entry point of the module — see MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * Routes: student payment tracking (debts + payments), mounted on /api/finance.
 * Service: inter-module API (campus dashboard counter, payment tracking, overdue cron).
 */

const routes  = require('./finance.routes');
const service = require('./finance.service');

module.exports = {
  routes,       // mounted by app.js on /api/finance
  service,      // inter-module API: require('../finance').service.<fn>
  // NO model exported. NO controller exported.
};
