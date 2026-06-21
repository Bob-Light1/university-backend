'use strict';

/**
 * @file expense.controller.js — HTTP layer for institutional expenses and their
 * categories.
 *
 * Management surface (ADMIN / DIRECTOR / CAMPUS_MANAGER): category CRUD, expense
 * CRUD and the approval workflow (approve / reject / pay). No Mongoose query
 * here — everything goes through expense.service. Campus scoping is derived from
 * the JWT (anti cross-campus leak).
 */

const service = require('../expense.service');
const {
  asyncHandler,
  sendSuccess,
  sendCreated,
  sendError,
  sendNotFound,
  sendForbidden,
  sendConflict,
  sendPaginated,
} = require('../../../shared/utils/response-helpers');
const { isValidObjectId, buildCampusFilter } = require('../../../shared/utils/validation-helpers');

const GLOBAL_ROLES = ['ADMIN', 'DIRECTOR'];

/** Derives the scope { schoolCampus? } from the JWT; 403 if isolation is impossible. */
function scopeFor(req, res) {
  try {
    return buildCampusFilter(req.user, req.query.campusId);
  } catch (err) {
    sendForbidden(res, err.message);
    return null;
  }
}

/**
 * Resolves the campus for a create operation. Expenses are always campus-bound:
 * forced to the JWT campus for local roles, required in the body for global ones.
 * Returns the id, or `null` after sending an error.
 */
function resolveCreateCampus(req, res) {
  if (GLOBAL_ROLES.includes(req.user.role)) {
    if (!isValidObjectId(req.body.schoolCampus)) {
      sendError(res, 400, 'schoolCampus is required for global roles');
      return null;
    }
    return req.body.schoolCampus;
  }
  if (!isValidObjectId(String(req.user.campusId))) {
    sendForbidden(res, 'No campus bound to your account');
    return null;
  }
  return req.user.campusId;
}

// ── Categories ────────────────────────────────────────────────────────────────

const createCategory = asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  if (!name || !String(name).trim()) return sendError(res, 400, 'name is required');
  try {
    const category = await service.createCategory({ name: String(name).trim(), description });
    return sendCreated(res, 'Category created', category);
  } catch (err) {
    if (err.code === 'CONFLICT') return sendConflict(res, err.message);
    throw err;
  }
});

const listCategories = asyncHandler(async (req, res) => {
  const categories = await service.listCategories();
  return sendSuccess(res, 200, 'Expense categories', categories);
});

const deleteCategory = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid category id');
  try {
    const category = await service.deleteCategory(req.params.id);
    if (!category) return sendNotFound(res, 'Category');
    return sendSuccess(res, 200, 'Category deleted', category);
  } catch (err) {
    if (err.code === 'CONFLICT') return sendConflict(res, err.message);
    throw err;
  }
});

// ── Expenses ──────────────────────────────────────────────────────────────────

const createExpense = asyncHandler(async (req, res) => {
  const {
    expenseCategory, title, description, reference, amount, currency, paymentMethod,
    expenseDate, isRecurring, recurringPeriod, attachments, notes,
  } = req.body;

  if (!isValidObjectId(expenseCategory)) return sendError(res, 400, 'A valid expenseCategory is required');
  if (!title || !String(title).trim()) return sendError(res, 400, 'title is required');
  if (amount === undefined || !Number.isFinite(Number(amount)) || Number(amount) < 0) {
    return sendError(res, 400, 'amount must be a number ≥ 0');
  }
  if (!paymentMethod) return sendError(res, 400, 'paymentMethod is required');
  if (!expenseDate || Number.isNaN(new Date(expenseDate).getTime())) {
    return sendError(res, 400, 'expenseDate must be a valid date');
  }

  const schoolCampus = resolveCreateCampus(req, res);
  if (schoolCampus === null) return undefined;

  try {
    const expense = await service.createExpense({
      schoolCampus,
      expenseCategory,
      paidBy: req.user.id,
      title: String(title).trim(),
      description,
      reference: reference || undefined,
      amount: Number(amount),
      currency,
      paymentMethod,
      expenseDate,
      isRecurring: Boolean(isRecurring),
      recurringPeriod: isRecurring ? recurringPeriod : undefined,
      attachments: Array.isArray(attachments) ? attachments : undefined,
      notes,
    });
    return sendCreated(res, 'Expense created', expense);
  } catch (err) {
    if (err.code === 'INVALID') return sendError(res, 400, err.message);
    throw err;
  }
});

const listExpenses = asyncHandler(async (req, res) => {
  const scope = scopeFor(req, res);
  if (scope === null) return undefined;

  const page  = parseInt(req.query.page, 10) || 1;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

  const filter = { ...scope };
  if (req.query.status) filter.status = req.query.status;
  if (isValidObjectId(req.query.category)) filter.expenseCategory = req.query.category;
  if (req.query.year) filter.year = parseInt(req.query.year, 10);
  if (req.query.month) filter.month = parseInt(req.query.month, 10);

  const { data, total } = await service.listExpenses({ filter, skip: (page - 1) * limit, limit });
  return sendPaginated(res, 200, 'Expenses', data, { total, page, limit });
});

const getExpense = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid expense id');
  const scope = scopeFor(req, res);
  if (scope === null) return undefined;

  const expense = await service.getExpense(req.params.id, scope);
  if (!expense) return sendNotFound(res, 'Expense');
  return sendSuccess(res, 200, 'Expense', expense);
});

// Fields a client may patch (campus/paidBy/status are never client-mutable here;
// status moves through the dedicated workflow endpoints).
const EXPENSE_UPDATABLE = [
  'expenseCategory', 'title', 'description', 'reference', 'amount', 'currency',
  'paymentMethod', 'expenseDate', 'isRecurring', 'recurringPeriod', 'attachments', 'notes',
];

const updateExpense = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid expense id');
  const scope = scopeFor(req, res);
  if (scope === null) return undefined;

  const updates = {};
  for (const key of EXPENSE_UPDATABLE) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (updates.expenseCategory !== undefined && !isValidObjectId(updates.expenseCategory)) {
    return sendError(res, 400, 'expenseCategory must be a valid id');
  }
  if (updates.amount !== undefined && (!Number.isFinite(Number(updates.amount)) || Number(updates.amount) < 0)) {
    return sendError(res, 400, 'amount must be a number ≥ 0');
  }
  if (Object.keys(updates).length === 0) return sendError(res, 400, 'No updatable field provided');

  try {
    const expense = await service.updateExpense(req.params.id, updates, scope);
    if (!expense) return sendNotFound(res, 'Expense');
    return sendSuccess(res, 200, 'Expense updated', expense);
  } catch (err) {
    if (err.code === 'INVALID') return sendError(res, 400, err.message);
    if (err.code === 'LOCKED') return sendError(res, 409, err.message);
    throw err;
  }
});

/** Factory: a workflow handler for a target status. */
const transitionTo = (target) => asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid expense id');
  const scope = scopeFor(req, res);
  if (scope === null) return undefined;

  try {
    const expense = await service.transitionExpense(req.params.id, target, { userId: req.user.id }, scope);
    if (!expense) return sendNotFound(res, 'Expense');
    return sendSuccess(res, 200, `Expense ${target}`, expense);
  } catch (err) {
    if (err.code === 'INVALID') return sendError(res, 409, err.message);
    throw err;
  }
});

const deleteExpense = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid expense id');
  const scope = scopeFor(req, res);
  if (scope === null) return undefined;

  const expense = await service.deleteExpense(req.params.id, scope);
  if (!expense) return sendNotFound(res, 'Expense');
  return sendSuccess(res, 200, 'Expense deleted', expense);
});

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
  approveExpense: transitionTo('approved'),
  rejectExpense: transitionTo('rejected'),
  payExpense: transitionTo('paid'),
  deleteExpense,
};
