/**
 * @file finance.service.js
 * Public API of the finance module (income / student payment tracking).
 * (Other domains NEVER touch these models directly — §3 of the guide.)
 * All persistence goes through finance.repository (step 0 pre-Postgres).
 */

const mongoose     = require('mongoose');
const financeRepo  = require('./finance.repository');
const { computeStatus } = require('./fee-status');
const notification = require('../notification').service;

/**
 * Number of pending payments (income) for a campus.
 * (Consumed by campus.controller for the dashboard paymentAlerts.)
 * @param {string|ObjectId} campusId
 * @returns {Promise<number>}
 */
function countPendingIncomes(campusId) {
  return financeRepo.countByCampusAndStatus(campusId, 'pending');
}

/**
 * Number of students with an outstanding balance (pending/partial/overdue) for a
 * campus. Powers the dashboard "payment alerts" KPI — student debts are the only
 * actively-written finance records, unlike Income which has no API writer yet.
 * @param {string|ObjectId} campusId
 * @returns {Promise<number>}
 */
function countOutstandingFees(campusId) {
  return financeRepo.countOutstandingFeesByCampus(campusId);
}

// ── Student payment tracking ──────────────────────────────────────────────────

/**
 * Notifies the student (in-app + email) of an outstanding balance. Fire-and-forget: a
 * send failure must never block the accounting operation (same contract as
 * the other emitters). Contact (email) and language resolved via the
 * student/settings facades — finance never queries their models (facade §3).
 * @param {Object} fee  debt (lean, with virtual `balance`)
 */
async function notifyBalanceDue(fee) {
  const balance = fee.balance ?? Math.max(0, (fee.amountDue || 0) - (fee.amountPaid || 0));
  if (balance <= 0) return;
  try {
    // Contact + language via the facades (finance does not touch the Student model;
    // language from UserPreferences, single source).
    const [contact, locale] = await Promise.all([
      require('../student').service.getStudentContact(fee.student),
      require('../settings').service.getPreferredLanguage(fee.student),
    ]);
    await notification.notify({
      recipient: { id: fee.student, model: 'Student', campusId: fee.schoolCampus, email: contact?.email },
      channels: ['inapp', 'email'], // email inert without SMTP → skipped
      template: 'payment.reminder',
      locale,
      data: {
        amount: balance,
        currency: fee.currency,
        dueDate: fee.dueDate ? new Date(fee.dueDate).toISOString().slice(0, 10) : '—',
      },
    });
  } catch (err) {
    console.error('[notify] payment.reminder failed:', err.message);
  }
}

/**
 * Creates a debt for a student and informs them of the amount due (in-app).
 * @param {Object} input { student, schoolCampus, label, academicYear?, amountDue, currency?, dueDate?, notes?, createdBy? }
 * @returns {Promise<Object>} the created debt (lean + balance)
 */
async function createFee(input) {
  const doc = await financeRepo.createFee(input);
  const fee = doc.toObject({ virtuals: true });
  notifyBalanceDue(fee);
  return fee;
}

/**
 * Applies a payment to a debt: creates the FeePayment line, updates the
 * `amountPaid` total (the status is recalculated on save), and returns the updated state.
 *
 * Guardrails: amount > 0, currency aligned with the debt, no overpayment
 * beyond the remaining balance, debt not cancelled.
 *
 * @param {Object} params { feeId, amount, method, reference?, paidAt?, notes?, recordedBy, scope? }
 * @returns {Promise<{ fee: Object, payment: Object }>}
 */
async function recordPayment({ feeId, amount, method, reference, paidAt, notes, recordedBy, scope = {} }) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw Object.assign(new Error('amount must be greater than 0'), { code: 'INVALID' });
  }

  // Up-front validation for fast, precise errors (not found / cancelled / overpay).
  const feeDoc = await financeRepo.getFeeDoc(feeId, scope);
  if (!feeDoc) throw Object.assign(new Error('Fee not found'), { code: 'NOT_FOUND' });
  if (feeDoc.status === 'cancelled') {
    throw Object.assign(new Error('Cannot pay a cancelled fee'), { code: 'INVALID' });
  }

  const balance = Math.max(0, (feeDoc.amountDue || 0) - (feeDoc.amountPaid || 0));
  if (value > balance) {
    throw Object.assign(
      new Error(`amount ${value} exceeds remaining balance ${balance}`),
      { code: 'INVALID' },
    );
  }

  // Authoritative write: atomic guarded increment closes the lost-update / overpay
  // race a read-modify-write save() leaves open under concurrent payments. A null
  // result means a competing payment changed the balance between the read above and
  // now (or the debt was cancelled/deleted meanwhile).
  const updatedFee = await financeRepo.incrementAmountPaidGuarded(feeDoc._id, value, scope);
  if (!updatedFee) {
    throw Object.assign(
      new Error('Payment rejected: the balance changed concurrently, please retry'),
      { code: 'INVALID' },
    );
  }

  let payment;
  try {
    payment = await financeRepo.createPayment({
      fee:          updatedFee._id,
      student:      updatedFee.student,
      schoolCampus: updatedFee.schoolCampus,
      amount:       value,
      currency:     updatedFee.currency,
      method,
      reference:    reference || undefined,
      paidAt:       paidAt || new Date(),
      notes,
      recordedBy,
    });
  } catch (err) {
    // Payment line creation failed (e.g. duplicate reference): roll back the
    // increment so the debt total stays consistent.
    await financeRepo.incrementAmountPaidGuarded(updatedFee._id, -value).catch(() => {});
    throw err;
  }

  // The atomic $inc bypassed the pre-save hook; recompute the derived status.
  const nextStatus = computeStatus(updatedFee);
  const fee = nextStatus !== updatedFee.status
    ? (await financeRepo.setFeeStatus(updatedFee._id, nextStatus)) || { ...updatedFee, status: nextStatus }
    : updatedFee;

  return {
    fee,
    payment: typeof payment.toObject === 'function' ? payment.toObject() : payment,
  };
}

/**
 * Full ledger of a student: debts + payments + totals.
 * @param {string|ObjectId} studentId
 * @param {Object} [scope] additional filter (e.g. { schoolCampus })
 * @returns {Promise<{ fees, payments, totals }>}
 */
async function getStudentLedger(studentId, scope = {}) {
  // Payments carry a denormalized schoolCampus → apply the same scope as the
  // debts so a manager cannot read another campus's payment lines.
  const [fees, payments] = await Promise.all([
    financeRepo.findFeesByStudent(studentId, scope),
    financeRepo.findPaymentsByStudent(studentId, scope),
  ]);
  const totals = fees.reduce(
    (acc, f) => {
      acc.totalDue  += f.amountDue || 0;
      acc.totalPaid += f.amountPaid || 0;
      return acc;
    },
    { totalDue: 0, totalPaid: 0 },
  );
  totals.balance = Math.max(0, totals.totalDue - totals.totalPaid);
  return { fees, payments, totals };
}

/**
 * Financial summary for a scope/period: received income vs paid expenses and the
 * resulting net. The scope is already campus-resolved by the caller (never the client).
 * @param {Object} [scope]  e.g. { schoolCampus }
 * @param {Object} [period] { year?, month? }
 * @returns {Promise<{ income, expense, net, currency }>}
 */
async function getFinancialSummary(scope = {}, period = {}) {
  // Aggregation pipelines do NOT auto-cast types (unlike find/count) → coerce the
  // campus id to an ObjectId so the $match works against ObjectId-stored fields.
  const match = {};
  if (scope.schoolCampus) {
    match.schoolCampus = new mongoose.Types.ObjectId(String(scope.schoolCampus));
  }
  if (period.year) match.year = period.year;
  if (period.month) match.month = period.month;

  const [incomeAgg, expenseAgg] = await Promise.all([
    financeRepo.sumIncomes(match),
    financeRepo.sumExpenses(match),
  ]);

  const income  = incomeAgg[0]  || { total: 0, count: 0 };
  const expense = expenseAgg[0] || { total: 0, count: 0 };
  return {
    income:  { total: income.total,  count: income.count },
    expense: { total: expense.total, count: expense.count },
    net: income.total - expense.total,
  };
}

/** Paginated list of debts (filter already campus-scoped by the caller). */
function listFees({ filter, skip, limit }) {
  return financeRepo.paginateFees({ filter, skip, limit });
}

/** A debt with its payments. @returns {Promise<{ fee, payments }|null>} */
async function getFeeWithPayments(feeId, scope = {}) {
  const fee = await financeRepo.findFeeById(feeId, scope);
  if (!fee) return null;
  const payments = await financeRepo.findPaymentsByFee(feeId);
  return { fee, payments };
}

/** Soft-delete of a debt. @returns {Promise<Object|null>} */
function deleteFee(feeId, scope = {}) {
  return financeRepo.softDeleteFee(feeId, scope);
}

/** (Re)sends a balance reminder for a given debt. @returns {Promise<Object|null>} */
async function remindBalance(feeId, scope = {}) {
  const fee = await financeRepo.findFeeById(feeId, scope);
  if (!fee) return null;
  await notifyBalanceDue(fee);
  return fee;
}

/**
 * Cron: moves unpaid past-due debts to `overdue` and sends a reminder.
 * Best-effort (does not interrupt the batch on a send failure).
 * @returns {Promise<{ processed: number }>}
 */
async function runOverdueJob() {
  const due = await financeRepo.findOverdueFees(new Date(), 100);
  for (const fee of due) {
    const doc = await financeRepo.getFeeDoc(fee._id);
    if (!doc) continue;
    await doc.save(); // pre-save recalculates → overdue
    await notifyBalanceDue(doc.toObject({ virtuals: true }));
  }
  if (due.length) console.log(`💸 [finance] overdue sweep: ${due.length} fee(s) processed`);
  return { processed: due.length };
}

module.exports = {
  countPendingIncomes,
  countOutstandingFees,
  getFinancialSummary,
  createFee,
  recordPayment,
  getStudentLedger,
  listFees,
  getFeeWithPayments,
  deleteFee,
  remindBalance,
  runOverdueJob,
};
