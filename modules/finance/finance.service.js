/**
 * @file finance.service.js
 * API publique du module finance (income / expense / expense-category).
 * (Les autres domaines ne touchent JAMAIS directement ces models — §3 du guide.)
 * Toute la persistance passe par finance.repository (étape 0 pré-Postgres).
 */

const financeRepo = require('./finance.repository');

/**
 * Nombre de paiements (income) en attente pour un campus.
 * (Consommé par campus.controller pour les paymentAlerts du dashboard —
 *  comportement identique au countDocuments qu'il exécutait directement.)
 *
 * @param {string|ObjectId} campusId
 * @returns {Promise<number>}
 */
function countPendingIncomes(campusId) {
  return financeRepo.countByCampusAndStatus(campusId, 'pending');
}

module.exports = {
  countPendingIncomes,
};
