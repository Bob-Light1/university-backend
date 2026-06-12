/**
 * @file index.js — FAÇADE du module level
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * Niveaux académiques. Monté sur /api/level.
 */

const routes  = require('./level.routes');
const service = require('./level.service');

module.exports = {
  routes,   // monté par server.js :  app.use('/api/level', routes)
  service,  // API inter-modules (vide pour l'instant — voir level.service.js)
  // PAS de model exporté. PAS de controller exporté.
};
