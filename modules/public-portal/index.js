/**
 * @file index.js — FAÇADE du module public-portal
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3 et §9.
 *
 * Couvre le portail public marketing (quiz, FAQ, témoignages, compétitions,
 * contact, aperçus de cours) ET son back-office portal-admin (même domaine,
 * mêmes models). Le business partenaire (partner.model, leads, commissions,
 * applications) reste dans le module `partner` — voir §9.
 */

const routes  = require('./public-portal.routes');
const service = require('./public-portal.service');

module.exports = {
  routes,   // monté par server.js :  app.use('/api', routes) → /api/public/* + /api/portal-admin/*
  service,  // { runCompetitionClosingJob }
  // PAS de model exporté. PAS de controller exporté.
};
