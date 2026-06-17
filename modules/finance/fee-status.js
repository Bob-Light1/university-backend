'use strict';

/**
 * @file fee-status.js — règle pure de calcul du statut d'une dette étudiant.
 *
 * Isolée (sans DB ni Mongoose) pour être partagée par le model (pre-save) ET
 * le service, et testée unitairement sans monter de base.
 *
 * Précédence : cancelled > paid > overdue > partial > pending.
 *   - cancelled : figé par l'opérateur, jamais recalculé.
 *   - paid      : montant réglé ≥ montant dû.
 *   - overdue   : solde restant > 0 ET échéance dépassée.
 *   - partial   : un acompte a été versé mais le solde n'est pas couvert.
 *   - pending   : rien versé, pas encore échu.
 */

const STATUSES = ['pending', 'partial', 'paid', 'overdue', 'cancelled'];

/**
 * @param {Object} fee
 * @param {number} fee.amountDue   montant total dû
 * @param {number} fee.amountPaid  montant déjà réglé
 * @param {Date|string|null} [fee.dueDate] échéance (optionnelle)
 * @param {string} [fee.status]    statut courant (pour préserver 'cancelled')
 * @param {Date}   [now]           injectable pour les tests
 * @returns {string} l'un de STATUSES
 */
function computeStatus({ amountDue, amountPaid = 0, dueDate = null, status = null } = {}, now = new Date()) {
  if (status === 'cancelled') return 'cancelled';

  const due  = Number(amountDue) || 0;
  const paid = Number(amountPaid) || 0;

  if (paid >= due && due > 0) return 'paid';
  if (due === 0) return 'paid'; // dette à 0 → considérée soldée

  const isOverdue = dueDate && new Date(dueDate).getTime() < now.getTime();
  if (isOverdue) return 'overdue';

  return paid > 0 ? 'partial' : 'pending';
}

module.exports = { computeStatus, STATUSES };
