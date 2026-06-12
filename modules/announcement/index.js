/**
 * @file index.js — FAÇADE du module announcement
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 */

const routes  = require('./announcement.routes');
const service = require('./announcement.service');

module.exports = {
  routes,   // monté par server.js :  app.use('/api/announcements', announcement.routes)
  service,  // API inter-modules    :  require('../announcement').service.runExpiryJob()
  // PAS de model exporté. PAS de controller exporté.
};
