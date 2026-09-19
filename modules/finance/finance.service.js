/**
 * @file finance.service.js
 * Public API of the finance module (income / student payment tracking).
 * (Other domains NEVER touch these models directly — §3 of the guide.)
 * All persistence goes through finance.repository (step 0 pre-Postgres).
 */

const mongoose     = require('mongoose');
const financeRepo  = require('./finance.repository');
const { computeStatus } = require('./fee-status');
const { dueReminderKind, preDueWindow } = require('./fee-reminder-kind');
const { buildReceiptHtml, receiptNumberOf } = require('./fee-receipt.template');
const { localeContext } = require('../../shared/i18n');
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
 * `fee.student` may be a raw ObjectId (create/payment paths) or a populated
 * object (detail/reminder/receipt reads). Resolves the bare id either way, so
 * the facades and the notification recipient always receive a plain id.
 */
const studentIdOf = (fee) => fee.student?._id ?? fee.student;

/**
 * The due date as a reminder prints it: long form, in the recipient's language,
 * or an em dash when the debt carries none.
 * @param {Date|string|null} dueDate
 * @param {string} locale
 * @returns {string}
 */
function formatDueDate(dueDate, locale) {
  if (!dueDate) return '—';
  const date = new Date(dueDate);
  if (Number.isNaN(date.getTime())) return '—';
  const { dateLocale } = localeContext(locale);
  return date.toLocaleDateString(dateLocale, { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Sends one balance notice to the student (in-app + email). Fire-and-forget: a
 * send failure must never block the accounting operation (same contract as the
 * other emitters). Contact (email) and language resolved via the
 * student/settings facades — finance never queries their models (facade §3).
 *
 * Shared by the two cadences deliberately: the overdue dunning notice and the
 * three pre-due notices differ by their TEMPLATE and by nothing else — same
 * recipient, same channels, same variables. Keeping one emitter is what
 * guarantees a pre-due reminder reaches a student's inbox under exactly the
 * conditions an overdue one does, entitlement gate included.
 *
 * @param {Object} fee       debt (lean, with virtual `balance`)
 * @param {string} template  notification template key
 */
async function notifyFeeBalance(fee, template) {
  const balance = fee.balance ?? Math.max(0, (fee.amountDue || 0) - (fee.amountPaid || 0));
  if (balance <= 0) return;
  const studentId = studentIdOf(fee);
  try {
    // Contact + language via the facades (finance does not touch the Student model;
    // language from UserPreferences, single source).
    const [contact, locale] = await Promise.all([
      require('../student').service.getStudentContact(studentId),
      require('../settings').service.getPreferredLanguage(studentId),
    ]);
    await notification.notify({
      recipient: {
        id: studentId, model: 'Student', campusId: fee.schoolCampus,
        email: contact?.email, prefs: contact?.notificationPrefs,
      },
      channels: ['inapp', 'email'], // email inert without SMTP → skipped
      template,
      locale,
      data: {
        // `{name}` is spelled out by every email body of the catalog. Passing it
        // is not decoration: `interpolate` renders a missing variable as an
        // empty string, so its absence reads as "Hello ," rather than as a bug.
        name: contact?.firstName || '',
        amount: balance,
        currency: fee.currency,
        // Written in the recipient's own language, from the same table the fee
        // receipt uses (`localeContext`): a student reading the reminder and the
        // receipt of one debt must not see that day written two ways.
        dueDate: formatDueDate(fee.dueDate, locale),
      },
    });
  } catch (err) {
    console.error(`[notify] ${template} failed:`, err.message);
  }
}

/**
 * Notifies the student of an outstanding balance (overdue cadence + every
 * manual and creation-time notice).
 * @param {Object} fee  debt (lean, with virtual `balance`)
 */
const notifyBalanceDue = (fee) => notifyFeeBalance(fee, 'payment.reminder');

/**
 * Notifies the student that a debt is about to fall due. The template is derived
 * from the cadence kind (`payment.due_in_7d` …), never spelled out at the call
 * site: `fee-reminder-kind.js` owns the list, and a kind added there without its
 * catalog entry is caught by the notification coverage suite rather than sent
 * blank.
 * @param {Object} fee   debt (lean, with virtual `balance`)
 * @param {string} kind  one of REMINDER_KINDS
 */
const notifyDueSoon = (fee, kind) => notifyFeeBalance(fee, `payment.${kind}`);

/**
 * Creates a debt for a student and informs them of the amount due (in-app).
 * @param {Object} input { student, schoolCampus, label, academicYear?, amountDue, currency?, dueDate?, notes?, createdBy? }
 * @returns {Promise<Object>} the created debt (lean + balance)
 */
async function createFee(input) {
  // Cross-document guard (campus isolation): the debt's student must exist AND
  // belong to the debt's campus. getStudentNamesByIds filters by campus, so an
  // empty result means "unknown student" or "student in another campus" — both
  // rejected here rather than silently creating an orphan/cross-campus debt.
  const [match] = await require('../student').service.getStudentNamesByIds(
    [input.student],
    input.schoolCampus,
  );
  if (!match) {
    throw Object.assign(
      new Error('Student not found in this campus'),
      { code: 'INVALID' },
    );
  }

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
    // Payment line creation failed (e.g. duplicate reference, invalid method):
    // roll back the increment so the debt total stays consistent.
    await financeRepo.incrementAmountPaidGuarded(updatedFee._id, -value).catch(() => {});
    // Surface client-fixable errors (validation / duplicate receipt #) as a clean
    // 400 instead of a 500.
    if (err.name === 'ValidationError') {
      throw Object.assign(new Error(err.message), { code: 'INVALID' });
    }
    if (err.code === 11000) {
      throw Object.assign(
        new Error('A payment with this reference already exists'),
        { code: 'INVALID' },
      );
    }
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

/**
 * Renders the PDF receipt of one payment.
 *
 * @param {string|ObjectId} paymentId
 * @param {Object} [scope] campus filter, plus `student` when the caller is the
 *   student themself — the route composes both conditions, the service applies
 *   whatever it is given (§3 of the design note).
 * @returns {Promise<{ buffer: Buffer, fileName: string, receiptNumber: string }|null>}
 *   null when no payment matches the scope — the route answers 404 either way,
 *   so a cross-campus id is indistinguishable from an unknown one.
 */
async function getPaymentReceipt(paymentId, scope = {}) {
  const payment = await financeRepo.findPaymentById(paymentId, scope);
  if (!payment) return null;

  const studentId = studentIdOf(payment);
  // The receipt is the STUDENT's proof of payment, so it is rendered in the
  // student's language even when a campus manager is the one downloading it —
  // the same rule, and the same source (UserPreferences), as the reminders.
  const [branding, locale] = await Promise.all([
    require('../academic-print').service.getCampusBranding(payment.schoolCampus),
    require('../settings').service.getPreferredLanguage(studentId),
  ]);

  const html = buildReceiptHtml({
    payment,
    fee: payment.fee || {},
    student: payment.student || {},
    branding,
    locale,
  });

  // One Puppeteer pool for the whole process, owned by academic-print: its FIFO
  // cap and its graceful shutdown only work while nobody opens a second one.
  const buffer = await require('../academic-print').service.renderPdf(html, {
    format: 'A4',
    margins: { top: '18mm', right: '16mm', bottom: '18mm', left: '16mm' },
  });

  const receiptNumber = receiptNumberOf(payment);
  return {
    buffer,
    receiptNumber,
    // Header-safe: the reference is operator-typed free text, and it travels in a
    // Content-Disposition header.
    fileName: `receipt-${receiptNumber.replace(/[^\w.-]+/g, '-')}.pdf`,
  };
}

/** Soft-delete of a debt. @returns {Promise<Object|null>} */
function deleteFee(feeId, scope = {}) {
  return financeRepo.softDeleteFee(feeId, scope);
}

/** (Re)sends a balance reminder for a given debt (manual admin action). @returns {Promise<Object|null>} */
async function remindBalance(feeId, scope = {}) {
  const fee = await financeRepo.findFeeById(feeId, scope);
  if (!fee) return null;
  const balance = fee.balance ?? Math.max(0, (fee.amountDue || 0) - (fee.amountPaid || 0));
  if (balance > 0) {
    await notifyBalanceDue(fee);
    await financeRepo.touchReminded(feeId, new Date()); // feeds the nightly cadence
  }
  return fee;
}

// Overdue dunning cadence: re-remind an unpaid overdue debt at most once per this
// window (env-overridable). The `lastRemindedAt` guard is what prevents the nightly
// sweep from spamming a student night after night for the same unpaid debt.
const REMINDER_INTERVAL_MS = (parseInt(process.env.FINANCE_REMINDER_INTERVAL_DAYS, 10) || 7) * 24 * 60 * 60 * 1000;
const OVERDUE_BATCH        = parseInt(process.env.FINANCE_OVERDUE_BATCH, 10) || 200;
const MAX_OVERDUE_BATCHES  = 1000; // hard safety bound on a single run

/**
 * Cron: (1) transition every past-due unpaid debt to `overdue` in one atomic write
 * (unbounded — no debt is silently skipped beyond a cap), then (2) send a balance
 * reminder to those due for one per the dunning cadence. Each reminder is claimed
 * atomically, so under horizontal scaling a debt is reminded at most once.
 * Best-effort: a send failure never interrupts the sweep (delivery is retried by
 * the notification module).
 *
 * ENTITLEMENT (design doc §9.1) — the two halves are governed differently, and
 * the split is the whole point of the rule "silence the emission, never the
 * hygiene":
 *
 *  - the transition runs for EVERY campus. A debt past its due date is a fact
 *    about a date, not an action taken in the module's name: it is invisible
 *    where Finance is hidden, and where Finance is merely frozen, freezing the
 *    transition too would leave the ledger showing `pending` on debts that are
 *    plainly overdue — a frozen module must keep its history readable (§4.1),
 *    not turn it into a lie. It would also fire a burst of transitions the day
 *    the module came back.
 *  - the reminders are suppressed per campus. They are outbound mail in the
 *    name of a module the operator switched off — the case this chantier exists
 *    for.
 *
 * @returns {Promise<{ transitioned: number, reminded: number, suppressedCampuses: number }>}
 */
async function runOverdueJob() {
  const now    = new Date();
  const cutoff = new Date(now.getTime() - REMINDER_INTERVAL_MS);

  const { modifiedCount: transitioned = 0 } = await financeRepo.markPastDueOverdue(now);

  // Resolved once per run, not once per debt.
  const excludeCampusIds = await require('../../shared/lib/entitlement').jobs
    .suppressedCampusIds('finance');

  // Batched cadence sweep. Each claimed debt gets `lastRemindedAt = now`, dropping
  // out of the next batch's window → the candidate set strictly shrinks and the
  // loop terminates (the batch cap is a defensive upper bound only).
  let reminded = 0;
  for (let i = 0; i < MAX_OVERDUE_BATCHES; i += 1) {
    const batch = await financeRepo.findRemindableOverdueFees(cutoff, OVERDUE_BATCH, { excludeCampusIds });
    if (!batch.length) break;
    for (const { _id } of batch) {
      const claimed = await financeRepo.claimFeeForReminder(_id, cutoff, now);
      if (!claimed) continue; // another instance already reminded this debt
      await notifyBalanceDue(claimed);
      reminded += 1;
    }
    if (batch.length < OVERDUE_BATCH) break;
  }

  if (transitioned || reminded || excludeCampusIds.length) {
    console.log(
      `💸 [finance] overdue sweep: ${transitioned} marked overdue, ${reminded} reminder(s) sent`
      + (excludeCampusIds.length ? `, ${excludeCampusIds.length} campus(es) silenced (Finance not active)` : '')
    );
  }
  return { transitioned, reminded, suppressedCampuses: excludeCampusIds.length };
}

const DUE_SOON_BATCH   = parseInt(process.env.FINANCE_DUE_SOON_BATCH, 10) || 200;
const MAX_DUE_SOON_PAGES = 1000; // hard safety bound on a single run

/**
 * Cron: the PRE-due cadence — notify a student at J-7, J-3 and on the due date,
 * while the debt can still be settled on time. Its counterpart `runOverdueJob`
 * only speaks once the money is already late.
 *
 * Three properties are load-bearing:
 *
 *  - **Pagination is by `_id`, not by `skip`.** Claiming a debt here does not
 *    remove it from the window (it stays until it falls due), so the candidate
 *    set does NOT shrink between pages — the assumption the overdue sweep may
 *    safely make would loop forever here.
 *  - **The kind is recomputed per debt, from its own due date.** A run missed on
 *    Sunday does not lose the cadence: a debt read at J-5 still receives the J-7
 *    notice it never got, and never a staler one than it is due (see
 *    `dueReminderKind`).
 *  - **The claim is what makes it idempotent**, not the query: two instances
 *    sweeping at 07:00 both see the debt, and exactly one `$push` succeeds.
 *
 * ENTITLEMENT — the whole job is emission (outbound mail in the name of the
 * Finance module), so it is suppressed per campus in the QUERY, exactly as the
 * overdue reminders are. There is no hygiene half to keep running here: unlike
 * the past-due transition, nothing about a debt's own state changes because a
 * notice was or was not sent.
 *
 * @returns {Promise<{ reminded: number, suppressedCampuses: number }>}
 */
async function runDueSoonJob() {
  const now = new Date();
  const { from, to } = preDueWindow(now);

  const excludeCampusIds = await require('../../shared/lib/entitlement').jobs
    .suppressedCampusIds('finance');

  let reminded = 0;
  let afterId  = null;
  for (let page = 0; page < MAX_DUE_SOON_PAGES; page += 1) {
    const batch = await financeRepo.findFeesDueSoon({
      from, to, afterId, limit: DUE_SOON_BATCH, excludeCampusIds,
    });
    if (!batch.length) break;

    for (const fee of batch) {
      const kind = dueReminderKind(fee.dueDate, now);
      if (!kind) continue; // outside the cadence (guards against a widened query)
      const claimed = await financeRepo.claimFeeForPreDueReminder(fee._id, kind, now);
      if (!claimed) continue; // already sent — by an earlier run or another instance
      await notifyDueSoon(claimed, kind);
      reminded += 1;
    }

    afterId = batch[batch.length - 1]._id;
    if (batch.length < DUE_SOON_BATCH) break;
  }

  if (reminded || excludeCampusIds.length) {
    console.log(
      `💸 [finance] pre-due sweep: ${reminded} reminder(s) sent`
      + (excludeCampusIds.length ? `, ${excludeCampusIds.length} campus(es) silenced (Finance not active)` : '')
    );
  }
  return { reminded, suppressedCampuses: excludeCampusIds.length };
}

// ── AI advisor aggregates (M5b — PHASE3_AI_DESIGN.md §6.5/§6.6) ───────────────

/** Age bands of the overdue aging distribution, keyed by $bucket _id. */
const AGING_BANDS = Object.freeze([
  { key: 0, band: '1-30' },
  { key: 31, band: '31-60' },
  { key: 61, band: '61-90' },
  { key: 'over90', band: '90+' },
]);

/**
 * Aging distribution of the campus's overdue student debts, consumed by the
 * AI finance advisor through /internal/ai/aggregates (M5b). PII-free by
 * construction: per-band counters, outstanding totals and average reminder
 * counts — never a student id or name. Bands are zero-filled so the engine
 * output is stable whatever the data (deterministic, testable).
 * @param {{ campusId: string|ObjectId }} scope
 * @returns {Promise<Object>} flat figures
 */
async function getOverdueAgingAggregates({ campusId }) {
  const campusOid = new mongoose.Types.ObjectId(String(campusId));
  const now = new Date();
  const rows = await financeRepo.aggregateOverdueAging(campusOid, now);
  const byKey = new Map(rows.map((row) => [row._id, row]));
  const buckets = AGING_BANDS.map(({ key, band }) => {
    const row = byKey.get(key);
    return {
      band,
      count: row?.count ?? 0,
      outstanding: row?.outstanding ?? 0,
      avgReminderCount: row ? Math.round(row.avgReminderCount * 10) / 10 : 0,
    };
  });
  return {
    totalCount: buckets.reduce((sum, b) => sum + b.count, 0),
    totalOutstanding: buckets.reduce((sum, b) => sum + b.outstanding, 0),
    buckets,
  };
}

/**
 * Monthly cashflow series of the campus over the last `months` months
 * (received incomes vs paid expenses, denormalized year/month pair), consumed
 * by the AI finance advisor (M5b). The series is continuous and zero-filled —
 * a month without records is an explicit zero, never a hole (the engine's
 * anomaly detection needs an evenly-spaced series).
 * @param {{ campusId: string|ObjectId, months?: number }} scope
 * @returns {Promise<Object>} flat figures
 */
async function getMonthlyCashflowSeries({ campusId, months = 12 }) {
  const campusOid = new mongoose.Types.ObjectId(String(campusId));
  const span = Math.min(Math.max(parseInt(months, 10) || 12, 3), 24);

  // Continuous (year, month) window ending on the current month.
  const now = new Date();
  const window = [];
  for (let i = span - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    window.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }
  const from = window[0];
  // (year, month) lower bound without touching incomeDate/expenseDate formats:
  // year > from.year OR (year == from.year AND month >= from.month).
  const periodMatch = {
    schoolCampus: campusOid,
    $or: [
      { year: { $gt: from.year } },
      { year: from.year, month: { $gte: from.month } },
    ],
  };

  const [incomeRows, expenseRows] = await Promise.all([
    financeRepo.monthlyIncomeTotals(periodMatch),
    financeRepo.monthlyExpenseTotals(periodMatch),
  ]);
  const keyOf = ({ year, month }) => `${year}-${month}`;
  const incomeBy = new Map(incomeRows.map((r) => [keyOf(r._id), r.total]));
  const expenseBy = new Map(expenseRows.map((r) => [keyOf(r._id), r.total]));

  return {
    months: span,
    series: window.map((period) => {
      const income = incomeBy.get(keyOf(period)) ?? 0;
      const expense = expenseBy.get(keyOf(period)) ?? 0;
      return { ...period, income, expense, net: income - expense };
    }),
  };
}

module.exports = {
  countPendingIncomes,
  countOutstandingFees,
  getFinancialSummary,
  getOverdueAgingAggregates,
  getMonthlyCashflowSeries,
  createFee,
  recordPayment,
  getStudentLedger,
  listFees,
  getFeeWithPayments,
  getPaymentReceipt,
  deleteFee,
  remindBalance,
  runOverdueJob,
  runDueSoonJob,
};
