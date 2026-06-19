/**
 * @file index.js — FACADE of the public-portal module
 * Sole public entry point of the module — see MODULAR_MONOLITH_MIGRATION.md §3 and §9.
 *
 * Covers the public marketing portal (quiz, FAQ, testimonials, competitions,
 * contact, course previews) AND its portal-admin back-office (same domain,
 * same models). The partner business (partner.model, leads, commissions,
 * applications) stays in the `partner` module — see §9.
 */

const routes  = require('./public-portal.routes');
const service = require('./public-portal.service');

module.exports = {
  routes,   // mounted by server.js:  app.use('/api', routes) → /api/public/* + /api/portal-admin/*
  service,  // { runCompetitionClosingJob }
  // NO model exported. NO controller exported.
};
