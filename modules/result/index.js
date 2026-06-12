/**
 * @file index.js — FAÇADE du module result
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * Notes/résultats, workflow de validation, analytics, relevés finaux
 * (FinalTranscript) et barèmes (GradingScale). Monté sur /api/results.
 */

const routes  = require('./result.routes');
const service = require('./result.service');

module.exports = {
  routes,   // monté par server.js :  app.use('/api/results', routes)
  service,  // API inter-modules (vide pour l'instant — voir result.service.js)
  // PAS de model exporté. PAS de controller exporté.
};
