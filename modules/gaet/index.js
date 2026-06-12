/**
 * @file index.js — FAÇADE du module GAET (Génération Automatique d'Emplois du Temps)
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 */

const routes  = require('./gaet.routes');
const service = require('./gaet.service');

module.exports = {
  routes,   // monté par server.js :  app.use('/api/gaet', gaet.routes)
  service,  // API inter-modules    :  require('../gaet').service.recoverZombieJobs()
  // PAS de model exporté. PAS de controller exporté.
};
