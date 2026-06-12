/**
 * @file index.js — FAÇADE du module campus
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * Campus (noyau) : CRUD, dashboard manager, login campus, préférences.
 * Le dashboard consomme les façades finance/mentor/settings/staff.
 * Monté sur /api/campus.
 */

const routes  = require('./campus.routes');
const service = require('./campus.service');

module.exports = {
  routes,   // monté par server.js :  app.use('/api/campus', routes)
  service,  // API inter-modules (vide pour l'instant — voir campus.service.js)
  // PAS de model exporté. PAS de controller exporté.
};
