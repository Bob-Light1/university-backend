/**
 * @file index.js — FAÇADE du module admin
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 */

const routes  = require('./admin.routes');
const service = require('./admin.service');

module.exports = {
  routes,   // monté par server.js :  app.use('/api/admin', admin.routes)
  service,  // API inter-modules (vide pour l'instant — voir admin.service.js)
  // PAS de model exporté. PAS de controller exporté.
};
