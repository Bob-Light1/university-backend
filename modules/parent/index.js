/**
 * @file index.js — FAÇADE du module parent
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 */

const routes  = require('./parent.routes');
const service = require('./parent.service');

module.exports = {
  routes,   // mounted by server.js :  app.use('/api/parents', parent.routes)
  service,  // inter-module API (empty for now — see parent.service.js)
  // NO model exported. NO controller exported.
};
