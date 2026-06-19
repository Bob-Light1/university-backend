/**
 * @file index.js — FACADE of the student module
 * The module's only public entry point — see MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * Students: CRUD/profile/dashboard, schedules, attendance.
 * Composite router — see student.routes.js.
 */

const routes  = require('./student.routes');
const service = require('./student.service');

module.exports = {
  routes,   // mounted by server.js:  app.use('/api', routes) → /api/students + /api/schedules/student + /api/attendance/student
  service,  // inter-module API (empty for now — see student.service.js)
  // NO model exported. NO controller exported.
};
