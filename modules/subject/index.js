/**
 * @file index.js — FACADE of the subject module
 * Sole public entry point of the module — see MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * Subjects. Mounted on /api/subject. ⚠️ subject.routes still consumes
 * course.resources.controller via a shim (pre-existing coupling — cleanup).
 */

const routes  = require('./subject.routes');
const service = require('./subject.service');

module.exports = {
  routes,   // mounted by server.js:  app.use('/api/subject', routes)
  service,  // inter-module API (empty for now — see subject.service.js)
  // NO model exported. NO controller exported.
};
