/**
 * @file index.js — FAÇADE du module parent
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 */

const routes  = require('./parent.routes');
const service = require('./parent.service');

module.exports = {
  routes,   // monté par server.js :  app.use('/api/parents', parent.routes)
  service,  // API inter-modules (vide pour l'instant — voir parent.service.js)
  // PAS de model exporté. PAS de controller exporté.
};
