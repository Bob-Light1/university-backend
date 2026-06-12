/**
 * @file index.js — FAÇADE du module teacher
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * Enseignants : CRUD/profil/dashboard, emplois du temps, présences.
 * Router composite — voir teacher.routes.js.
 */

const routes  = require('./teacher.routes');
const service = require('./teacher.service');

module.exports = {
  routes,   // monté par server.js :  app.use('/api', routes) → /api/teachers + /api/schedules/teacher + /api/attendance/teacher
  service,  // API inter-modules (vide pour l'instant — voir teacher.service.js)
  // PAS de model exporté. PAS de controller exporté.
};
