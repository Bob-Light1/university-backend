/**
 * @file index.js — FAÇADE du module finance
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * Routes : suivi paiement étudiant (dettes + acomptes), montées sur /api/finance.
 * Service : API inter-modules (compteur dashboard campus, suivi paiement, cron overdue).
 */

const routes  = require('./finance.routes');
const service = require('./finance.service');

module.exports = {
  routes,       // monté par app.js sur /api/finance
  service,      // API inter-modules : require('../finance').service.<fn>
  // PAS de model exporté. PAS de controller exporté.
};
