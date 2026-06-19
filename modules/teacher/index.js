/**
 * @file index.js — FACADE of the teacher module
 * The module's only public entry point — see MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * Teachers: CRUD/profile/dashboard, schedules, attendance.
 * Composite router — see teacher.routes.js.
 */

const routes  = require('./teacher.routes');
const service = require('./teacher.service');

module.exports = {
  routes,   // mounted by server.js:  app.use('/api', routes) → /api/teachers + /api/schedules/teacher + /api/attendance/teacher
  service,  // inter-module API (empty for now — see teacher.service.js)
  // NO model exported. NO controller exported.
};
