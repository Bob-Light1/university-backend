/**
 * @file index.js — FAÇADE du module document
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * GED : documents, versions, partages, templates, audit, rétention,
 * génération PDF/QR. Monté sur /api/documents.
 */

const routes  = require('./document.routes');
const service = require('./document.service');

module.exports = {
  routes,   // monté par server.js :  app.use('/api/documents', routes)
  service,  // { runRetentionJob, shutdownPool }
  // PAS de model exporté. PAS de controller exporté.
};
