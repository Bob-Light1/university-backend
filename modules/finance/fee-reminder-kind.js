'use strict';

/**
 * @file fee-reminder-kind.js — pure rule for the PRE-DUE reminder cadence.
 *
 * Isolated (no DB, no Mongoose) like its sibling `fee-status.js`, so the model,
 * the repository and the nightly sweep share one definition of the cadence and
 * it stays unit-testable without a database.
 *
 * WHY A PER-KIND MARKER AND NOT THE EXISTING COUNTER
 * `StudentFee.lastRemindedAt` / `reminderCount` already govern the OVERDUE
 * dunning cadence: `claimFeeForReminder` picks a debt only when its
 * `lastRemindedAt` is older than the cadence window. Stamping those same fields
 * for a pre-due reminder would drop the debt out of that claim — so a debt
 * reminded at J-3 would skip its overdue reminder on the day it falls past due,
 * and it would skip it *because* the earlier reminder worked. Two cadences, two
 * markers; this file owns the pre-due one.
 *
 * WHY `overdue` IS NOT ONE OF THE KINDS BELOW
 * The overdue cadence REPEATS — one reminder per window, for as long as the debt
 * stands, which is why it counts with `$inc`. The pre-due cadence fires each kind
 * AT MOST ONCE per debt, which is what lets `remindersSent[]` be claimed
 * idempotently. Declaring `overdue` here would invite a writer to record it in an
 * array whose whole invariant is "one entry per kind", and recreate the very
 * collision this file exists to prevent.
 */

/** The three notices sent before a debt falls due. Order = decreasing lead time. */
const REMINDER_KINDS = Object.freeze({
  DUE_IN_7D: 'due_in_7d',
  DUE_IN_3D: 'due_in_3d',
  DUE_TODAY: 'due_today',
});

/** Days before the due date at which each kind becomes eligible. */
const REMINDER_LEAD_DAYS = Object.freeze({
  [REMINDER_KINDS.DUE_IN_7D]: 7,
  [REMINDER_KINDS.DUE_IN_3D]: 3,
  [REMINDER_KINDS.DUE_TODAY]: 0,
});

/** Enum values, for the schema and for validators. */
const REMINDER_KIND_VALUES = Object.freeze(Object.values(REMINDER_KINDS));

// Midnight UTC and the day length come from `fee-status.js`, which owns the
// past-due boundary. Two definitions of "which day is it" is exactly what let
// the 06:00 transition and this cadence disagree (design note §9⑰).
const { startOfUtcDay, DAY_MS } = require('./fee-status');

/**
 * Whole days from `now` to `dueDate`, counted in UTC days rather than in elapsed
 * hours: a debt due "tomorrow" is 1 day away whether it is read at 07:00 or 23:00.
 * @param {Date|string} dueDate
 * @param {Date} [now]
 * @returns {number|null} null when there is no due date
 */
function daysUntilDue(dueDate, now = new Date()) {
  if (!dueDate) return null;
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) return null;
  return Math.round((startOfUtcDay(due) - startOfUtcDay(now)) / DAY_MS);
}

/**
 * The single notice a debt is due for today, or null.
 *
 * Eligibility is `leadDays >= daysUntil`, and among the eligible kinds the one
 * with the SMALLEST lead wins. Two consequences, both deliberate:
 *   - a missed run does not lose the cadence — a debt read at J-5 whose J-7
 *     notice never went out still gets it, since 7 >= 5;
 *   - but it never gets a STALE one: at J-3 the eligible set is {7d, 3d} and the
 *     3d notice wins, so nobody is told "due in 7 days" three days before.
 * A past-due debt returns null: it belongs to the overdue cadence, which has its
 * own claim and its own counter.
 *
 * @param {Date|string} dueDate
 * @param {Date} [now]
 * @returns {string|null} one of REMINDER_KINDS
 */
function dueReminderKind(dueDate, now = new Date()) {
  const daysUntil = daysUntilDue(dueDate, now);
  if (daysUntil === null || daysUntil < 0) return null;

  let winner = null;
  for (const kind of REMINDER_KIND_VALUES) {
    const lead = REMINDER_LEAD_DAYS[kind];
    if (lead < daysUntil) continue;
    if (winner === null || lead < REMINDER_LEAD_DAYS[winner]) winner = kind;
  }
  return winner;
}

/**
 * The date window the pre-due sweep has to read, derived from the cadence itself
 * rather than restated: from midnight UTC today (inclusive) to midnight UTC the
 * day after the longest lead time (exclusive). Adding a fourth kind at J-14
 * widens the window by editing one table.
 *
 * @param {Date} [now]
 * @returns {{ from: Date, to: Date }}
 */
function preDueWindow(now = new Date()) {
  const maxLead = Math.max(...Object.values(REMINDER_LEAD_DAYS));
  const from = startOfUtcDay(now);
  return { from: new Date(from), to: new Date(from + (maxLead + 1) * DAY_MS) };
}

module.exports = {
  REMINDER_KINDS,
  REMINDER_KIND_VALUES,
  REMINDER_LEAD_DAYS,
  daysUntilDue,
  dueReminderKind,
  preDueWindow,
};
