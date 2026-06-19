/**
 * @file index.js — FAÇADE du module announcement
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 */

const routes  = require('./announcement.routes');
const service = require('./announcement.service');

module.exports = {
  routes,   // mounted by server.js :  app.use('/api/announcements', announcement.routes)
  service,  // inter-module API     :  require('../announcement').service.runExpiryJob()
  // NO model exported. NO controller exported.
};
