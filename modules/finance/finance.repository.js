'use strict';

/**
 * @file finance.repository.js — couche de persistance du domaine finance.
 *
 * SEUL fichier du module autorisé à toucher les models (income / expense /
 * expense-category). Le service appelle ce repository (jamais les models).
 * Étape 0 de la préparation Postgres — voir POSTGRES_MIGRATION_ASSESSMENT.md §7.
 *
 * Seul `income` est interrogé pour l'instant (compteur dashboard campus) ; les
 * accès expense/expense-category viendront avec la phase ERP, via ce repository.
 */

const Income = require('./models/income.model');

/**
 * Compte les income d'un campus dans un statut donné.
 * @param {string|ObjectId} campusId
 * @param {string} status
 * @returns {Promise<number>}
 */
const countByCampusAndStatus = (campusId, status) =>
  Income.countDocuments({ campus: campusId, status });

module.exports = {
  countByCampusAndStatus,
};
