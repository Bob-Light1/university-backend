/**
 * @file index.js — FAÇADE du module GAET (Génération Automatique d'Emplois du Temps)
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 */

const routes  = require('./gaet.routes');
const service = require('./gaet.service');

module.exports = {
  routes,   // mounted by server.js :  app.use('/api/gaet', gaet.routes)
  service,  // inter-module API     :  require('../gaet').service.recoverZombieJobs()
  // NO model exported. NO controller exported.
};
