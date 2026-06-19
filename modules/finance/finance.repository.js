'use strict';

/**
 * @file finance.repository.js — persistence layer of the finance domain.
 *
 * The ONLY file in the module allowed to touch the models (income / expense /
 * expense-category / studentFee / feePayment). The service calls this repository
 * (never the models).
 * Step 0 of the Postgres preparation — see POSTGRES_MIGRATION_ASSESSMENT.md §7.
 */

const Income     = require('./models/income.model');
const StudentFee = require('./models/studentFee.model');
const FeePayment = require('./models/feePayment.model');

// ── Income (campus dashboard counter) ─────────────────────────────────────────

/**
 * Counts a campus's incomes in a given status.
 * @param {string|ObjectId} campusId
 * @param {string} status
 * @returns {Promise<number>}
 */
const countByCampusAndStatus = (campusId, status) =>
  Income.countDocuments({ campus: campusId, status });

// ── StudentFee (debts) ────────────────────────────────────────────────────────

/** Creates a debt. @returns {Promise<Object>} document (non-lean, for reuse). */
const createFee = (doc) => StudentFee.create(doc);

/** Debt by id (filtered not-deleted), lean enriched with the `balance` virtual. */
const findFeeById = (id, extra = {}) =>
  StudentFee.findOne({ _id: id, isDeleted: false, ...extra }).lean({ virtuals: true });

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
    StudentFee.find(query).sort(sort).skip(skip).limit(limit).lean({ virtuals: true }),
    StudentFee.countDocuments(query),
  ]);
  return { data, total };
};

/** All of a student's debts (ledger), sorted by creation. */
const findFeesByStudent = (studentId, extra = {}) =>
  StudentFee.find({ student: studentId, isDeleted: false, ...extra })
    .sort({ createdAt: -1 })
    .lean({ virtuals: true });

/** Soft-delete of a debt. @returns {Promise<Object|null>} */
const softDeleteFee = (id, extra = {}) =>
  StudentFee.findOneAndUpdate(
    { _id: id, isDeleted: false, ...extra },
    { $set: { isDeleted: true } },
    { new: true },
  ).lean({ virtuals: true });

/**
 * Past-due debts still unpaid (overdue sweep / reminders).
 * @param {Date} now
 * @param {number} limit
 * @returns {Promise<Object[]>}
 */
const findOverdueFees = (now, limit = 100) =>
  StudentFee.find({
    isDeleted: false,
    dueDate: { $ne: null, $lt: now },
    status: { $in: ['pending', 'partial'] },
  })
    .limit(limit)
    .lean({ virtuals: true });

// ── FeePayment (payments) ─────────────────────────────────────────────────────

/** Creates a payment line. @returns {Promise<Object>} */
const createPayment = (doc) => FeePayment.create(doc);

/** Payments attached to a debt, sorted by date. */
const findPaymentsByFee = (feeId) =>
  FeePayment.find({ fee: feeId }).sort({ paidAt: -1 }).lean();

/** A student's payments (global ledger). */
const findPaymentsByStudent = (studentId) =>
  FeePayment.find({ student: studentId }).sort({ paidAt: -1 }).lean();

module.exports = {
  // income
  countByCampusAndStatus,
  // fees
  createFee,
  findFeeById,
  getFeeDoc,
  paginateFees,
  findFeesByStudent,
  softDeleteFee,
  findOverdueFees,
  // payments
  createPayment,
  findPaymentsByFee,
  findPaymentsByStudent,
};
