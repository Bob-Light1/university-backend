'use strict';

/**
 * @file fee-status.js — pure rule for computing a student debt's status.
 *
 * Isolated (no DB, no Mongoose) so it can be shared by the model (pre-save) AND
 * the service, and unit-tested without spinning up a database.
 *
 * Precedence: cancelled > paid > overdue > partial > pending.
 *   - cancelled : frozen by the operator, never recalculated.
 *   - paid      : amount paid ≥ amount due.
 *   - overdue   : remaining balance > 0 AND due date passed.
 *   - partial   : a payment was made but the balance is not covered.
 *   - pending   : nothing paid, not yet due.
 */

const STATUSES = ['pending', 'partial', 'paid', 'overdue', 'cancelled'];

/**
 * @param {Object} fee
 * @param {number} fee.amountDue   total amount due
 * @param {number} fee.amountPaid  amount already paid
 * @param {Date|string|null} [fee.dueDate] due date (optional)
 * @param {string} [fee.status]    current status (to preserve 'cancelled')
 * @param {Date}   [now]           injectable for tests
 * @returns {string} one of STATUSES
 */
function computeStatus({ amountDue, amountPaid = 0, dueDate = null, status = null } = {}, now = new Date()) {
  if (status === 'cancelled') return 'cancelled';

  const due  = Number(amountDue) || 0;
  const paid = Number(amountPaid) || 0;

  if (paid >= due && due > 0) return 'paid';
  if (due === 0) return 'paid'; // zero debt → considered settled

  const isOverdue = dueDate && new Date(dueDate).getTime() < now.getTime();
  if (isOverdue) return 'overdue';

  return paid > 0 ? 'partial' : 'pending';
}

module.exports = { computeStatus, STATUSES };
