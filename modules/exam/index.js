/**
 * @file index.js — FAÇADE du module exam
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * Examens en ligne : sessions, banque de questions, inscriptions, passation
 * (delivery), correction (grading), recours (appeals), certificats, analytics
 * (worker in-process) et cron anti-triche. Monté sur /api/examination.
 */

const routes  = require('./exam.routes');
const service = require('./exam.service');

module.exports = {
  routes,   // mounted by server.js:  app.use('/api/examination', routes)
  service,  // { runAntiCheatJob }
  // No model exported. No controller exported.
};
