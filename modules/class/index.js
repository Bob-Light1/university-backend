/**
 * @file index.js — FAÇADE du module class
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * Classes (groupes d'étudiants). Monté sur /api/class.
 */

const routes  = require('./class.routes');
const service = require('./class.service');

module.exports = {
  routes,   // monté par server.js :  app.use('/api/class', routes)
  service,  // API inter-modules (vide pour l'instant — voir class.service.js)
  // PAS de model exporté. PAS de controller exporté.
};
