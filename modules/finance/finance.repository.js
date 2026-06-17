'use strict';

/**
 * @file finance.repository.js — couche de persistance du domaine finance.
 *
 * SEUL fichier du module autorisé à toucher les models (income / expense /
 * expense-category / studentFee / feePayment). Le service appelle ce repository
 * (jamais les models).
 * Étape 0 de la préparation Postgres — voir POSTGRES_MIGRATION_ASSESSMENT.md §7.
 */

const Income     = require('./models/income.model');
const StudentFee = require('./models/studentFee.model');
const FeePayment = require('./models/feePayment.model');

// ── Income (compteur dashboard campus) ────────────────────────────────────────

/**
 * Compte les income d'un campus dans un statut donné.
 * @param {string|ObjectId} campusId
 * @param {string} status
 * @returns {Promise<number>}
 */
const countByCampusAndStatus = (campusId, status) =>
  Income.countDocuments({ campus: campusId, status });

// ── StudentFee (dettes) ───────────────────────────────────────────────────────

/** Crée une dette. @returns {Promise<Object>} document (non-lean, pour réutilisation). */
const createFee = (doc) => StudentFee.create(doc);

/** Dette par id (filtrée non supprimée), lean enrichi du virtuel `balance`. */
const findFeeById = (id, extra = {}) =>
  StudentFee.findOne({ _id: id, isDeleted: false, ...extra }).lean({ virtuals: true });

/** Document Mongoose d'une dette (pour mutation via save()). */
const getFeeDoc = (id, extra = {}) =>
  StudentFee.findOne({ _id: id, isDeleted: false, ...extra });

/**
 * Liste paginée des dettes selon un filtre (déjà scopé campus par l'appelant).
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

/** Toutes les dettes d'un étudiant (relevé), triées par création. */
const findFeesByStudent = (studentId, extra = {}) =>
  StudentFee.find({ student: studentId, isDeleted: false, ...extra })
    .sort({ createdAt: -1 })
    .lean({ virtuals: true });

/** Soft-delete d'une dette. @returns {Promise<Object|null>} */
const softDeleteFee = (id, extra = {}) =>
  StudentFee.findOneAndUpdate(
    { _id: id, isDeleted: false, ...extra },
    { $set: { isDeleted: true } },
    { new: true },
  ).lean({ virtuals: true });

/**
 * Dettes échues encore impayées (sweep overdue / rappels).
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

// ── FeePayment (acomptes) ─────────────────────────────────────────────────────

/** Crée une ligne de paiement. @returns {Promise<Object>} */
const createPayment = (doc) => FeePayment.create(doc);

/** Paiements rattachés à une dette, triés par date. */
const findPaymentsByFee = (feeId) =>
  FeePayment.find({ fee: feeId }).sort({ paidAt: -1 }).lean();

/** Paiements d'un étudiant (relevé global). */
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
