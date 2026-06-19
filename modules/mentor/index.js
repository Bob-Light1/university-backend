/**
 * @file index.js — FAÇADE du module mentor
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 */

const routes  = require('./mentor.routes');
const service = require('./mentor.service');

module.exports = {
  routes,   // mounted by server.js :  app.use('/api/mentors', mentor.routes)
  service,  // inter-module API     :  require('../mentor').service.getCampusStats(...)
  // NO model exported. NO controller exported.
};
