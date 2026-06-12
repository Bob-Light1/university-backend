/**
 * @file index.js — FAÇADE du module finance
 * Seul point d'entrée public du module — voir MODULAR_MONOLITH_MIGRATION.md §3.
 *
 * Particularité : ce domaine n'expose PAS encore de routes HTTP (les models
 * expense/expense-category sont prévus pour une phase ERP future). `routes`
 * vaut null pour garder la forme de façade homogène — server.js ne le monte pas.
 */

const service = require('./finance.service');

module.exports = {
  routes: null, // pas de router pour ce domaine (encore)
  service,      // API inter-modules :  require('../finance').service.countPendingIncomes(id)
  // PAS de model exporté. PAS de controller exporté.
};
