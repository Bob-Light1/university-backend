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
 *   - overdue   : remaining balance > 0 AND the due DAY has passed.
 *   - partial   : a payment was made but the balance is not covered.
 *   - pending   : nothing paid, not yet due.
 *
 * WHY THE DUE *DAY* AND NOT THE DUE *INSTANT*
 * A due date is a day, not a moment: `<input type="date">` sends midnight UTC,
 * so reading `dueDate < now` made a debt late at 00:00:01 of the very day it was
 * due. That is wrong on its own terms, and it had a second cost the finance
 * module measured (design note §9⑰): the 06:00 sweep transitioned the debt out
 * of `pending` an hour before the 07:00 pre-due sweep — which reads STORED
 * status — could send its `due_today` notice. One third of the declared cadence
 * never fired, silently. The debtor owns the whole of their due day.
 */

const STATUSES = ['pending', 'partial', 'paid', 'overdue', 'cancelled'];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Midnight UTC of a date. UTC and not host time, because the crons that read
 * this rule are registered on UTC (`register-jobs.js`, `CRON_TIMEZONE`): a
 * local-time boundary would shift the transition by a day for one timezone and
 * for nobody else.
 * @param {Date|string|number} date
 * @returns {number} epoch milliseconds of that day's 00:00 UTC
 */
const startOfUtcDay = (date) => {
  const d = new Date(date);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

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

  // Late once the due DAY is over — never during it. See the header.
  const isOverdue = dueDate && startOfUtcDay(dueDate) < startOfUtcDay(now);
  if (isOverdue) return 'overdue';

  return paid > 0 ? 'partial' : 'pending';
}

module.exports = { computeStatus, STATUSES, startOfUtcDay, DAY_MS };
