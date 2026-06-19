/**
 * @file index.js — FAÇADE du module class
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * Classes (groupes d'étudiants). Monté sur /api/class.
 */

const routes  = require('./class.routes');
const service = require('./class.service');

module.exports = {
  routes,   // mounted by server.js :  app.use('/api/class', routes)
  service,  // inter-module API (empty for now — see class.service.js)
  // NO model exported. NO controller exported.
};
