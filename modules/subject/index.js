/**
 * @file index.js — FAÇADE du module subject
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * Matières. Monté sur /api/subject. ⚠️ subject.routes consomme encore
 * course.resources.controller via shim (couplage préexistant — nettoyage).
 */

const routes  = require('./subject.routes');
const service = require('./subject.service');

module.exports = {
  routes,   // monté par server.js :  app.use('/api/subject', routes)
  service,  // API inter-modules (vide pour l'instant — voir subject.service.js)
  // PAS de model exporté. PAS de controller exporté.
};
