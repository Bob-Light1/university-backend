'use strict';

/**
 * @file income.service.js — business logic for institutional income records.
 *
 * All persistence goes through finance.repository (step 0 pre-Postgres). Campus
 * scoping is applied by the controller via buildCampusFilter; this layer never
 * trusts a campus from the client.
 */

const financeRepo = require('./finance.repository');

/**
 * Creates an income record.
 * @param {Object} input validated payload (already campus-resolved by the controller)
 * @returns {Promise<Object>} the created income (lean)
 */
async function createIncome(input) {
  // Cross-document guard (campus isolation): when an income is linked to a
  // student, that student must belong to the income's campus. Skipped when no
  // student link, or when the campus is unresolved (global role without a
  // campus override) — there is no campus to check against in that case.
  if (input.student && input.schoolCampus) {
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
  }

  const doc = await financeRepo.createIncome(input);
  return doc.toObject();
}

/** Paginated list of incomes (filter already campus-scoped by the caller). */
function listIncomes({ filter, skip, limit }) {
  return financeRepo.paginateIncomes({ filter, skip, limit });
}

/** A single income, scoped. @returns {Promise<Object|null>} */
function getIncome(id, scope = {}) {
  return financeRepo.findIncomeById(id, scope);
}

/**
 * Partial update of an income (whitelisted fields only). Recomputes month/year
 * via the pre-save hook when incomeDate changes.
 * @returns {Promise<Object|null>}
 */
async function updateIncome(id, updates, scope = {}) {
  const doc = await financeRepo.getIncomeDoc(id, scope);
  if (!doc) return null;
  // A re-linked student must still belong to the income's (immutable) campus.
  if (updates.student && doc.schoolCampus && String(updates.student) !== String(doc.student || '')) {
    const [match] = await require('../student').service.getStudentNamesByIds(
      [updates.student],
      doc.schoolCampus,
    );
    if (!match) {
      throw Object.assign(
        new Error('Student not found in this campus'),
        { code: 'INVALID' },
      );
    }
  }
  Object.assign(doc, updates);
  await doc.save();
  return doc.toObject();
}

/** Soft-delete of an income. @returns {Promise<Object|null>} */
function deleteIncome(id, scope = {}) {
  return financeRepo.softDeleteIncome(id, scope);
}

module.exports = {
  createIncome,
  listIncomes,
  getIncome,
  updateIncome,
  deleteIncome,
};
