/**
 * @file index.js — FAÇADE du module mentor
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 */

const routes  = require('./mentor.routes');
const service = require('./mentor.service');

module.exports = {
  routes,   // monté par server.js :  app.use('/api/mentors', mentor.routes)
  service,  // API inter-modules    :  require('../mentor').service.getCampusStats(...)
  // PAS de model exporté. PAS de controller exporté.
};
