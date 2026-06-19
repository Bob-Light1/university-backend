/**
 * @file index.js — FACADE of the notification module (Phase 2 foundation).
 * Sole public entry point of the module — see MODULAR_MONOLITH_MIGRATION.md §3.
 */

const routes  = require('./notification.routes');
const service = require('./notification.service');

module.exports = {
  routes,   // mounted by app.js          :  app.use('/api/notifications', notification.routes)
  service,  // inter-module API           :  require('../notification').service.notify({ ... })
  // + retry cron                         :  cron.schedule('*/10 * * * *', service.runRetryJob)
  // NO model exported. NO controller exported.
};
