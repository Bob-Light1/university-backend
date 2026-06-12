/**
 * @file finance.service.js
 * API publique du module finance (income / expense / expense-category).
 * (Les autres domaines ne touchent JAMAIS directement ces models — §3 du guide.)
 */

const Income = require('./models/income.model');

/**
 * Nombre de paiements (income) en attente pour un campus.
 * (Consommé par campus.controller pour les paymentAlerts du dashboard —
 *  comportement identique au countDocuments qu'il exécutait directement.)
 *
 * @param {string|ObjectId} campusId
 * @returns {Promise<number>}
 */
function countPendingIncomes(campusId) {
  return Income.countDocuments({ campus: campusId, status: 'pending' });
}

module.exports = {
  countPendingIncomes,
};
