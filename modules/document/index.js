/**
 * @file index.js — FAÇADE du module document
 * The module's only public entry point — see MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * DMS: documents, versions, shares, templates, audit, retention,
 * PDF/QR generation. Mounted on /api/documents.
 */

const routes  = require('./document.routes');
const service = require('./document.service');

module.exports = {
  routes,   // mounted by server.js :  app.use('/api/documents', routes)
  service,  // { runRetentionJob, shutdownPool }
  // NO model exported. NO controller exported.
};
