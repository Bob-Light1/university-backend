/**
 * @file finance.service.js
 * Public API of the finance module (income / student payment tracking).
 * (Other domains NEVER touch these models directly — §3 of the guide.)
 * All persistence goes through finance.repository (step 0 pre-Postgres).
 */

const financeRepo  = require('./finance.repository');
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
  const feeDoc = await financeRepo.getFeeDoc(feeId, scope);
  if (!feeDoc) throw Object.assign(new Error('Fee not found'), { code: 'NOT_FOUND' });
  if (feeDoc.status === 'cancelled') {
    throw Object.assign(new Error('Cannot pay a cancelled fee'), { code: 'INVALID' });
  }

  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw Object.assign(new Error('amount must be greater than 0'), { code: 'INVALID' });
  }

  const balance = Math.max(0, (feeDoc.amountDue || 0) - (feeDoc.amountPaid || 0));
  if (value > balance) {
    throw Object.assign(
      new Error(`amount ${value} exceeds remaining balance ${balance}`),
      { code: 'INVALID' },
    );
  }

  const payment = await financeRepo.createPayment({
    fee:          feeDoc._id,
    student:      feeDoc.student,
    schoolCampus: feeDoc.schoolCampus,
    amount:       value,
    currency:     feeDoc.currency,
    method,
    reference:    reference || undefined,
    paidAt:       paidAt || new Date(),
    notes,
    recordedBy,
  });

  feeDoc.amountPaid = (feeDoc.amountPaid || 0) + value; // pre-save recalculates the status
  await feeDoc.save();

  return {
    fee: feeDoc.toObject({ virtuals: true }),
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
  const [fees, payments] = await Promise.all([
    financeRepo.findFeesByStudent(studentId, scope),
    financeRepo.findPaymentsByStudent(studentId),
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
  createFee,
  recordPayment,
  getStudentLedger,
  listFees,
  getFeeWithPayments,
  deleteFee,
  remindBalance,
  runOverdueJob,
};
