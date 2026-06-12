/**
 * @file announcement.service.js
 * API publique du module announcement.
 * (Les autres modules / server.js ne touchent JAMAIS directement aux models — §3.)
 */

const { runExpiryJob } = require('./announcement.expiry.cron');

module.exports = {
  // Cron nocturne (archivage des annonces expirées + dé-épinglage).
  // Planifié par server.js : cron.schedule('0 1 * * *', service.runExpiryJob)
  runExpiryJob,
};
