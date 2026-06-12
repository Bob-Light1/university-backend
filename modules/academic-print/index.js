/**
 * @file index.js — FAÇADE du module academic-print
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * Impressions académiques (PDF) : listes de classe, emplois du temps,
 * relevés — génération Puppeteer + QR. Monté sur /api/print.
 */

const routes  = require('./academic-print.routes');
const service = require('./academic-print.service');

module.exports = {
  routes,   // monté par server.js :  app.use('/api/print', routes)
  service,  // { shutdownAcademicPool, cleanupExpiredPrintFiles }
  // PAS de model exporté. PAS de controller exporté.
};
