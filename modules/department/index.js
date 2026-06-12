/**
 * @file index.js — FAÇADE du module department
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * Départements académiques. Monté sur /api/department.
 */

const routes  = require('./department.routes');
const service = require('./department.service');

module.exports = {
  routes,   // monté par server.js :  app.use('/api/department', routes)
  service,  // API inter-modules (vide pour l'instant — voir department.service.js)
  // PAS de model exporté. PAS de controller exporté.
};
