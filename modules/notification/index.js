/**
 * @file index.js — FAÇADE du module notification (socle Phase 2).
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 */

const routes  = require('./notification.routes');
const service = require('./notification.service');

module.exports = {
  routes,   // monté par app.js          :  app.use('/api/notifications', notification.routes)
  service,  // API inter-modules         :  require('../notification').service.notify({ ... })
  // + cron de retry                      :  cron.schedule('*/10 * * * *', service.runRetryJob)
  // PAS de model exporté. PAS de controller exporté.
};
