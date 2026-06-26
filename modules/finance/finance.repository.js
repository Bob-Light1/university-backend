'use strict';

/**
 * @file finance.repository.js — persistence layer of the finance domain.
 *
 * The ONLY file in the module allowed to touch the models (income / expense /
 * expense-category / studentFee / feePayment). The service calls this repository
 * (never the models).
 * Step 0 of the Postgres preparation — see POSTGRES_MIGRATION_ASSESSMENT.md §7.
 */

const { escapeRegex } = require('../../shared/utils/validation-helpers');

const Income          = require('./models/income.model');
const Expense         = require('./models/expense.model');
const ExpenseCategory = require('./models/expense-category.model');
const StudentFee      = require('./models/studentFee.model');
const FeePayment      = require('./models/feePayment.model');

// Populated projections kept minimal: the list/detail views only need the
// student's display identity and the expense category name. Defined once so
// every read stays consistent (and cheap).
const STUDENT_FIELDS  = 'firstName lastName matricule';
const CATEGORY_FIELDS = 'name';

// ── Income ────────────────────────────────────────────────────────────────────

/**
 * Counts a campus's incomes in a given status.
 * @param {string|ObjectId} campusId
 * @param {string} status
 * @returns {Promise<number>}
 */
const countByCampusAndStatus = (campusId, status) =>
  Income.countDocuments({ schoolCampus: campusId, status, isDeleted: false });

/** Creates an income record. @returns {Promise<Object>} */
const createIncome = (doc) => Income.create(doc);

/** Income by id (not deleted), lean — student identity populated for the detail view. */
const findIncomeById = (id, extra = {}) =>
  Income.findOne({ _id: id, isDeleted: false, ...extra })
    .populate('student', STUDENT_FIELDS)
    .lean();

/** Paginated incomes by filter (already campus-scoped by the caller). */
const paginateIncomes = async ({ filter, skip, limit, sort = { incomeDate: -1 } }) => {
  const query = { isDeleted: false, ...filter };
  const [data, total] = await Promise.all([
    Income.find(query).populate('student', STUDENT_FIELDS).sort(sort).skip(skip).limit(limit).lean(),
    Income.countDocuments(query),
  ]);
  return { data, total };
};

/** Mongoose document of an income (for mutation via save()). */
const getIncomeDoc = (id, extra = {}) =>
  Income.findOne({ _id: id, isDeleted: false, ...extra });

/** Soft-delete of an income. @returns {Promise<Object|null>} */
const softDeleteIncome = (id, extra = {}) =>
  Income.findOneAndUpdate(
    { _id: id, isDeleted: false, ...extra },
    { $set: { isDeleted: true } },
    { new: true },
  ).lean();

/** Sum of received incomes for a campus over an optional period. */
const sumIncomes = (match) =>
  Income.aggregate([
    { $match: { isDeleted: false, status: 'received', ...match } },
    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);

// ── Expense ─────────────────────────────────────────────────────────────────

/** Creates an expense record. @returns {Promise<Object>} */
const createExpense = (doc) => Expense.create(doc);

/** Expense by id (not deleted), lean — category name populated for display. */
const findExpenseById = (id, extra = {}) =>
  Expense.findOne({ _id: id, isDeleted: false, ...extra })
    .populate('expenseCategory', CATEGORY_FIELDS)
    .lean();

/** Mongoose document of an expense (for mutation via save()). */
const getExpenseDoc = (id, extra = {}) =>
  Expense.findOne({ _id: id, isDeleted: false, ...extra });

/** Paginated expenses by filter (already campus-scoped by the caller). */
const paginateExpenses = async ({ filter, skip, limit, sort = { expenseDate: -1 } }) => {
  const query = { isDeleted: false, ...filter };
  const [data, total] = await Promise.all([
    Expense.find(query).populate('expenseCategory', CATEGORY_FIELDS).sort(sort).skip(skip).limit(limit).lean(),
    Expense.countDocuments(query),
  ]);
  return { data, total };
};

/** Soft-delete of an expense. @returns {Promise<Object|null>} */
const softDeleteExpense = (id, extra = {}) =>
  Expense.findOneAndUpdate(
    { _id: id, isDeleted: false, ...extra },
    { $set: { isDeleted: true } },
    { new: true },
  ).lean();

/** Sum of paid expenses for a campus over an optional period. */
const sumExpenses = (match) =>
  Expense.aggregate([
    { $match: { isDeleted: false, status: 'paid', ...match } },
    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);

// ── ExpenseCategory ───────────────────────────────────────────────────────────

/** Creates a category. @returns {Promise<Object>} */
const createCategory = (doc) => ExpenseCategory.create(doc);

/** All non-deleted categories, sorted by name. */
const listCategories = () =>
  ExpenseCategory.find({ isDeleted: false }).sort({ name: 1 }).lean();

/** Category by id (not deleted), lean. */
const findCategoryById = (id) =>
  ExpenseCategory.findOne({ _id: id, isDeleted: false }).lean();

/** Case-insensitive lookup of a category by exact name (duplicate guard). */
const findCategoryByName = (name) =>
  ExpenseCategory.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, 'i'), isDeleted: false }).lean();

/** Soft-delete of a category. @returns {Promise<Object|null>} */
const softDeleteCategory = (id) =>
  ExpenseCategory.findOneAndUpdate(
    { _id: id, isDeleted: false },
    { $set: { isDeleted: true } },
    { new: true },
  ).lean();

/** Count of non-deleted expenses referencing a category (deletion guard). */
const countExpensesByCategory = (categoryId) =>
  Expense.countDocuments({ expenseCategory: categoryId, isDeleted: false });

// ── StudentFee (debts) ────────────────────────────────────────────────────────

/** Creates a debt. @returns {Promise<Object>} document (non-lean, for reuse). */
const createFee = (doc) => StudentFee.create(doc);

/**
 * Counts a campus's debts still owing (not fully paid, not cancelled).
 * Powers the dashboard "payment alerts" KPI.
 * @param {string|ObjectId} campusId
 * @returns {Promise<number>}
 */
const countOutstandingFeesByCampus = (campusId) =>
  StudentFee.countDocuments({
    schoolCampus: campusId,
    isDeleted: false,
    status: { $in: ['pending', 'partial', 'overdue'] },
  });

/** Debt by id (filtered not-deleted), lean enriched with the `balance` virtual. */
const findFeeById = (id, extra = {}) =>
  StudentFee.findOne({ _id: id, isDeleted: false, ...extra })
    .populate('student', STUDENT_FIELDS)
    .lean({ virtuals: true });

/** Mongoose document of a debt (for mutation via save()). */
const getFeeDoc = (id, extra = {}) =>
  StudentFee.findOne({ _id: id, isDeleted: false, ...extra });

/**
 * Paginated list of debts by a filter (already campus-scoped by the caller).
 * @returns {Promise<{ data: Object[], total: number }>}
 */
const paginateFees = async ({ filter, skip, limit, sort = { createdAt: -1 } }) => {
  const query = { isDeleted: false, ...filter };
  const [data, total] = await Promise.all([
    StudentFee.find(query).populate('student', STUDENT_FIELDS).sort(sort).skip(skip).limit(limit).lean({ virtuals: true }),
    StudentFee.countDocuments(query),
  ]);
  return { data, total };
};

/** All of a student's debts (ledger), sorted by creation. */
const findFeesByStudent = (studentId, extra = {}) =>
  StudentFee.find({ student: studentId, isDeleted: false, ...extra })
    .sort({ createdAt: -1 })
    .lean({ virtuals: true });

/**
 * Atomically applies a delta to `amountPaid`, guarded against overpayment and
 * cancelled debts. Single document update → safe under concurrent payments
 * (no lost-update / overpay race that a read-modify-write `save()` would allow).
 *
 * The guard `amountDue >= amountPaid + delta` rejects an overpay; for a negative
 * delta (rollback) it always holds. Returns the post-update lean doc, or null
 * when the guard fails (not found / cancelled / would overpay).
 *
 * @param {string|ObjectId} id
 * @param {number} delta  amount to add (negative to roll back)
 * @param {Object} [extra] additional scope filter (e.g. { schoolCampus })
 * @returns {Promise<Object|null>}
 */
const incrementAmountPaidGuarded = (id, delta, extra = {}) =>
  StudentFee.findOneAndUpdate(
    {
      _id: id,
      isDeleted: false,
      status: { $ne: 'cancelled' },
      ...extra,
      $expr: { $gte: ['$amountDue', { $add: ['$amountPaid', delta] }] },
    },
    { $inc: { amountPaid: delta } },
    { new: true },
  ).lean({ virtuals: true });

/** Persists a derived status (used after an atomic amountPaid update bypasses pre-save). */
const setFeeStatus = (id, status) =>
  StudentFee.findByIdAndUpdate(id, { $set: { status } }, { new: true }).lean({ virtuals: true });

/** Soft-delete of a debt. @returns {Promise<Object|null>} */
const softDeleteFee = (id, extra = {}) =>
  StudentFee.findOneAndUpdate(
    { _id: id, isDeleted: false, ...extra },
    { $set: { isDeleted: true } },
    { new: true },
  ).lean({ virtuals: true });

/**
 * Bulk-transitions every past-due unpaid debt (`pending`/`partial`) to `overdue`
 * in a single atomic write — no per-document save, no arbitrary cap, so a spike of
 * newly-overdue debts is never silently dropped. Mirrors `computeStatus` (a past-due
 * debt with a remaining balance is `overdue`).
 * @param {Date} now
 * @returns {Promise<{ modifiedCount: number }>}
 */
const markPastDueOverdue = (now) =>
  StudentFee.updateMany(
    {
      isDeleted: false,
      dueDate: { $ne: null, $lt: now },
      status: { $in: ['pending', 'partial'] },
      $expr: { $lt: ['$amountPaid', '$amountDue'] }, // remaining balance > 0
    },
    { $set: { status: 'overdue' } }
  );

/**
 * Overdue debts due for a (re)reminder: never reminded, or last reminded before
 * `cutoff` (the dunning cadence window). Oldest due date first for fairness and
 * deterministic ordering across batches.
 * @param {Date} cutoff
 * @param {number} limit
 * @returns {Promise<Object[]>}
 */
const findRemindableOverdueFees = (cutoff, limit = 200) =>
  StudentFee.find({
    isDeleted: false,
    status: 'overdue',
    $or: [{ lastRemindedAt: null }, { lastRemindedAt: { $lt: cutoff } }],
  })
    .sort({ dueDate: 1 })
    .limit(limit)
    .select('_id')
    .lean();

/**
 * Atomically claims an overdue debt for a reminder (stamps `lastRemindedAt`,
 * bumps `reminderCount`) only if it is still due for one. Returns the claimed fee
 * (lean, with virtual `balance`) or null if another instance already reminded it —
 * makes the nightly sweep multi-instance safe (no duplicate reminder).
 * @param {string|ObjectId} feeId
 * @param {Date} cutoff
 * @param {Date} now
 * @returns {Promise<Object|null>}
 */
const claimFeeForReminder = (feeId, cutoff, now) =>
  StudentFee.findOneAndUpdate(
    {
      _id: feeId,
      status: 'overdue',
      $or: [{ lastRemindedAt: null }, { lastRemindedAt: { $lt: cutoff } }],
    },
    { $set: { lastRemindedAt: now }, $inc: { reminderCount: 1 } },
    { new: true }
  ).lean({ virtuals: true });

/** Stamps a manual reminder (admin endpoint) — unconditional, bumps the counter. */
const touchReminded = (feeId, now) =>
  StudentFee.updateOne(
    { _id: feeId },
    { $set: { lastRemindedAt: now }, $inc: { reminderCount: 1 } }
  );

// ── FeePayment (payments) ─────────────────────────────────────────────────────

/** Creates a payment line. @returns {Promise<Object>} */
const createPayment = (doc) => FeePayment.create(doc);

/** Payments attached to a debt, sorted by date. */
const findPaymentsByFee = (feeId) =>
  FeePayment.find({ fee: feeId }).sort({ paidAt: -1 }).lean();

/** A student's payments (ledger), optionally campus-scoped. */
const findPaymentsByStudent = (studentId, extra = {}) =>
  FeePayment.find({ student: studentId, ...extra }).sort({ paidAt: -1 }).lean();

module.exports = {
  // income
  countByCampusAndStatus,
  createIncome,
  findIncomeById,
  getIncomeDoc,
  paginateIncomes,
  softDeleteIncome,
  sumIncomes,
  // expense
  createExpense,
  findExpenseById,
  getExpenseDoc,
  paginateExpenses,
  softDeleteExpense,
  sumExpenses,
  // expense category
  createCategory,
  listCategories,
  findCategoryById,
  findCategoryByName,
  softDeleteCategory,
  countExpensesByCategory,
  // fees
  createFee,
  countOutstandingFeesByCampus,
  findFeeById,
  getFeeDoc,
  paginateFees,
  findFeesByStudent,
  incrementAmountPaidGuarded,
  setFeeStatus,
  softDeleteFee,
  markPastDueOverdue,
  findRemindableOverdueFees,
  claimFeeForReminder,
  touchReminded,
  // payments
  createPayment,
  findPaymentsByFee,
  findPaymentsByStudent,
};
