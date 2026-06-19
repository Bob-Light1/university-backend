/**
 * @file index.js — FAÇADE du module admin
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 */

const routes  = require('./admin.routes');
const service = require('./admin.service');

module.exports = {
  routes,   // mounted by server.js :  app.use('/api/admin', admin.routes)
  service,  // inter-module API (empty for now — see admin.service.js)
  // NO model exported. NO controller exported.
};
