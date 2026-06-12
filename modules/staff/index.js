/**
 * @file index.js — FAÇADE du module staff (membres + rôles/permissions)
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 */

const routes  = require('./staff.routes');
const service = require('./staff.service');

module.exports = {
  routes,   // monté par server.js :  app.use('/api', staff.routes)  → /api/staff + /api/staff-roles
  service,  // API inter-modules    :  require('../staff').service.getCampusStats(id)
  // PAS de model exporté. PAS de controller exporté.
};
