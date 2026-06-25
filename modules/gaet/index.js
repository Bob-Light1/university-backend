/**
 * @file index.js — FACADE of the GAET module (Automatic Timetable Generation).
 * @description Sole public entry point of the module — see MODULAR_MONOLITH_MIGRATION.md §3.
 */

const routes  = require('./gaet.routes');
const service = require('./gaet.service');

module.exports = {
  routes,   // mounted by server.js :  app.use('/api/gaet', gaet.routes)
  service,  // inter-module API     :  require('../gaet').service.recoverZombieJobs()
  // NO model exported. NO controller exported.
};
