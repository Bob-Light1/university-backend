/**
 * @file index.js — FAÇADE du module settings
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 */

const routes  = require('./settings.routes');
const service = require('./settings.service');

module.exports = {
  routes,   // monté par server.js :  app.use('/api/settings', settings.routes)
  service,  // API inter-modules    :  require('../settings').service.SUPPORTED_TIMEZONES
  // PAS de model exporté. PAS de controller exporté.
};
