/**
 * @file index.js — FAÇADE du module partner
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3 et §9.
 *
 * Business partenaire : comptes partenaires, leads (pré-inscriptions),
 * commissions, candidatures partenaires. Le portail public marketing
 * (quiz, FAQ, témoignages…) vit dans `public-portal` — voir §9.
 */

const routes  = require('./partner.routes');
const service = require('./partner.service');

module.exports = {
  routes,   // monté par server.js :  app.use('/api/partners', routes)
  service,  // API inter-modules (vide pour l'instant — voir partner.service.js)
  // PAS de model exporté. PAS de controller exporté.
};
