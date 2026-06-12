/**
 * @file index.js — FAÇADE du module student
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * Étudiants : CRUD/profil/dashboard, emplois du temps, présences.
 * Router composite — voir student.routes.js.
 */

const routes  = require('./student.routes');
const service = require('./student.service');

module.exports = {
  routes,   // monté par server.js :  app.use('/api', routes) → /api/students + /api/schedules/student + /api/attendance/student
  service,  // API inter-modules (vide pour l'instant — voir student.service.js)
  // PAS de model exporté. PAS de controller exporté.
};
