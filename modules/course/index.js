/**
 * @file index.js — FACADE of the course module
 * Sole public entry point of the module — see MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * Courses: CRUD, publication workflow, learning resources.
 * Mounted on /api/courses.
 */

const routes  = require('./course.routes');
const service = require('./course.service');

module.exports = {
  routes,   // mounted by server.js:  app.use('/api/courses', routes)
  service,  // inter-module API (empty for now — see course.service.js)
  // NO model exported. NO controller exported.
};
