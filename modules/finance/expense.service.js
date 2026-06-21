'use strict';

/**
 * @file expense.service.js — business logic for institutional expenses and their
 * categories.
 *
 * Persistence goes through finance.repository. The approval workflow is
 * pending → approved → paid (or rejected). Campus scoping is resolved by the
 * controller; this layer never trusts a campus from the client.
 */

const financeRepo = require('./finance.repository');

// ── Categories ────────────────────────────────────────────────────────────────

/**
 * Creates an expense category, rejecting a case-insensitive duplicate name.
 * @throws {Error} code 'CONFLICT' when the name already exists.
 */
async function createCategory({ name, description }) {
  const existing = await financeRepo.findCategoryByName(name);
  if (existing) {
    throw Object.assign(new Error(`Category '${name}' already exists`), { code: 'CONFLICT' });
  }
  const doc = await financeRepo.createCategory({ name, description });
  return doc.toObject();
}

/** All non-deleted categories. */
function listCategories() {
  return financeRepo.listCategories();
}

/**
 * Soft-deletes a category, refusing if expenses still reference it.
 * @throws {Error} code 'CONFLICT' when the category is in use.
 * @returns {Promise<Object|null>} null when the category does not exist.
 */
async function deleteCategory(id) {
  const inUse = await financeRepo.countExpensesByCategory(id);
  if (inUse > 0) {
    throw Object.assign(
      new Error(`Category is used by ${inUse} expense(s) and cannot be deleted`),
      { code: 'CONFLICT' },
    );
  }
  return financeRepo.softDeleteCategory(id);
}

// ── Expenses ──────────────────────────────────────────────────────────────────

/**
 * Creates an expense after checking the referenced category exists.
 * @throws {Error} code 'INVALID' when the category is unknown.
 * @returns {Promise<Object>} the created expense (lean).
 */
async function createExpense(input) {
  const category = await financeRepo.findCategoryById(input.expenseCategory);
  if (!category) {
    throw Object.assign(new Error('Unknown expense category'), { code: 'INVALID' });
  }
  const doc = await financeRepo.createExpense(input);
  return doc.toObject();
}

/** Paginated list of expenses (filter already campus-scoped by the caller). */
function listExpenses({ filter, skip, limit }) {
  return financeRepo.paginateExpenses({ filter, skip, limit });
}

/** A single expense, scoped. @returns {Promise<Object|null>} */
function getExpense(id, scope = {}) {
  return financeRepo.findExpenseById(id, scope);
}

/**
 * Partial update of an expense (whitelisted fields only). Validates the category
 * when changed. Refuses to mutate a paid expense (financial integrity).
 * @throws {Error} codes 'INVALID' | 'LOCKED'
 * @returns {Promise<Object|null>}
 */
async function updateExpense(id, updates, scope = {}) {
  const doc = await financeRepo.getExpenseDoc(id, scope);
  if (!doc) return null;
  if (doc.status === 'paid') {
    throw Object.assign(new Error('A paid expense can no longer be edited'), { code: 'LOCKED' });
  }
  if (updates.expenseCategory && updates.expenseCategory !== String(doc.expenseCategory)) {
    const category = await financeRepo.findCategoryById(updates.expenseCategory);
    if (!category) throw Object.assign(new Error('Unknown expense category'), { code: 'INVALID' });
  }
  Object.assign(doc, updates);
  await doc.save();
  return doc.toObject();
}

/**
 * Advances an expense in the approval workflow.
 * Transitions: pending → approved | rejected ; approved → paid.
 * @param {string} id
 * @param {'approved'|'rejected'|'paid'} target
 * @param {Object} actor { userId } the operator
 * @param {Object} [scope]
 * @throws {Error} codes 'INVALID' (illegal transition)
 * @returns {Promise<Object|null>}
 */
async function transitionExpense(id, target, actor, scope = {}) {
  const doc = await financeRepo.getExpenseDoc(id, scope);
  if (!doc) return null;

  const ALLOWED = {
    pending: ['approved', 'rejected'],
    approved: ['paid', 'rejected'],
    paid: [],
    rejected: [],
  };
  if (!ALLOWED[doc.status]?.includes(target)) {
    throw Object.assign(
      new Error(`Cannot move expense from '${doc.status}' to '${target}'`),
      { code: 'INVALID' },
    );
  }

  doc.status = target;
  if (target === 'approved') doc.approvedBy = actor.userId;
  if (target === 'paid') doc.paidAt = doc.paidAt || new Date();
  await doc.save();
  return doc.toObject();
}

/** Soft-delete of an expense. @returns {Promise<Object|null>} */
function deleteExpense(id, scope = {}) {
  return financeRepo.softDeleteExpense(id, scope);
}

module.exports = {
  // categories
  createCategory,
  listCategories,
  deleteCategory,
  // expenses
  createExpense,
  listExpenses,
  getExpense,
  updateExpense,
  transitionExpense,
  deleteExpense,
};
