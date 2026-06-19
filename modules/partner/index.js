/**
 * @file index.js — FACADE of the partner module
 * Sole public entry point of the module — see MODULAR_MONOLITH_MIGRATION.md §3 and §9.
 *
 * Partner business: partner accounts, leads (pre-registrations),
 * commissions, partner applications. The public marketing portal
 * (quiz, FAQ, testimonials…) lives in `public-portal` — see §9.
 */

const routes  = require('./partner.routes');
const service = require('./partner.service');

module.exports = {
  routes,   // mounted by server.js:  app.use('/api/partners', routes)
  service,  // inter-module API (empty for now — see partner.service.js)
  // NO model exported. NO controller exported.
};
