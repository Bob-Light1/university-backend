/**
 * @file index.js — FAÇADE du module course
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * Cours : CRUD, workflow de publication, ressources pédagogiques.
 * Monté sur /api/courses.
 */

const routes  = require('./course.routes');
const service = require('./course.service');

module.exports = {
  routes,   // monté par server.js :  app.use('/api/courses', routes)
  service,  // API inter-modules (vide pour l'instant — voir course.service.js)
  // PAS de model exporté. PAS de controller exporté.
};
