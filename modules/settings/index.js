/**
 * @file index.js — FAÇADE du module settings
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 */

const routes  = require('./settings.routes');
const service = require('./settings.service');

module.exports = {
  routes,   // mounted by server.js :  app.use('/api/settings', settings.routes)
  service,  // inter-module API     :  require('../settings').service.SUPPORTED_TIMEZONES
  // NO model exported. NO controller exported.
};
