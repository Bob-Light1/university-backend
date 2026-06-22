'use strict';

/**
 * @file income.controller.js — HTTP layer for institutional income records.
 *
 * Management surface (ADMIN / DIRECTOR / CAMPUS_MANAGER): create, list, view,
 * update, delete incomes. No Mongoose query here — everything goes through
 * income.service. Campus scoping is derived from the JWT (anti cross-campus leak).
 */

const service = require('../income.service');
const {
  asyncHandler,
  sendSuccess,
  sendCreated,
  sendError,
  sendNotFound,
  sendForbidden,
  sendPaginated,
  handleDuplicateKeyError,
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
 * Resolves the campus for a create operation: forced to the JWT campus for local
 * roles, optionally taken from the body for global roles. Returns `undefined`
 * (no campus) for a global role that omits it, or `null` after sending an error.
 */
function resolveCreateCampus(req, res) {
  if (GLOBAL_ROLES.includes(req.user.role)) {
    if (req.body.schoolCampus === undefined || req.body.schoolCampus === null || req.body.schoolCampus === '') {
      return undefined;
    }
    if (!isValidObjectId(req.body.schoolCampus)) {
      sendError(res, 400, 'schoolCampus must be a valid id');
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

const createIncome = asyncHandler(async (req, res) => {
  const {
    title, description, reference, source, amount, currency, paymentMethod,
    incomeDate, receivedAt, student, class: klass, course, status, attachments, notes,
  } = req.body;

  if (!title || !String(title).trim()) return sendError(res, 400, 'title is required');
  if (!source) return sendError(res, 400, 'source is required');
  if (amount === undefined || !Number.isFinite(Number(amount)) || Number(amount) < 0) {
    return sendError(res, 400, 'amount must be a number ≥ 0');
  }
  if (!paymentMethod) return sendError(res, 400, 'paymentMethod is required');
  if (!incomeDate || Number.isNaN(new Date(incomeDate).getTime())) {
    return sendError(res, 400, 'incomeDate must be a valid date');
  }
  for (const [field, value] of [['student', student], ['class', klass], ['course', course]]) {
    if (value !== undefined && value !== null && value !== '' && !isValidObjectId(value)) {
      return sendError(res, 400, `${field} must be a valid id`);
    }
  }

  const schoolCampus = resolveCreateCampus(req, res);
  if (schoolCampus === null) return undefined;

  try {
    const income = await service.createIncome({
      title: String(title).trim(),
      description,
      reference: reference || undefined,
      source,
      amount: Number(amount),
      currency,
      paymentMethod,
      incomeDate,
      receivedAt: receivedAt || undefined,
      student: student || undefined,
      class: klass || undefined,
      course: course || undefined,
      schoolCampus,
      status,
      attachments: Array.isArray(attachments) ? attachments : undefined,
      notes,
      receivedBy: req.user.id,
    });
    return sendCreated(res, 'Income created', income);
  } catch (err) {
    if (err.code === 'INVALID') return sendError(res, 400, err.message);
    if (err.code === 11000) return handleDuplicateKeyError(res, err);
    throw err;
  }
});

const listIncomes = asyncHandler(async (req, res) => {
  const scope = scopeFor(req, res);
  if (scope === null) return undefined;

  const page  = parseInt(req.query.page, 10) || 1;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

  const filter = { ...scope };
  if (req.query.source) filter.source = req.query.source;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.year) filter.year = parseInt(req.query.year, 10);
  if (req.query.month) filter.month = parseInt(req.query.month, 10);
  if (isValidObjectId(req.query.student)) filter.student = req.query.student;

  const { data, total } = await service.listIncomes({ filter, skip: (page - 1) * limit, limit });
  return sendPaginated(res, 200, 'Incomes', data, { total, page, limit });
});

const getIncome = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid income id');
  const scope = scopeFor(req, res);
  if (scope === null) return undefined;

  const income = await service.getIncome(req.params.id, scope);
  if (!income) return sendNotFound(res, 'Income');
  return sendSuccess(res, 200, 'Income', income);
});

// Fields a client may patch (campus/receivedBy are never client-mutable).
const INCOME_UPDATABLE = [
  'title', 'description', 'reference', 'source', 'amount', 'currency',
  'paymentMethod', 'incomeDate', 'receivedAt', 'student', 'class', 'course',
  'status', 'attachments', 'notes',
];

const updateIncome = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid income id');
  const scope = scopeFor(req, res);
  if (scope === null) return undefined;

  const updates = {};
  for (const key of INCOME_UPDATABLE) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (updates.amount !== undefined && (!Number.isFinite(Number(updates.amount)) || Number(updates.amount) < 0)) {
    return sendError(res, 400, 'amount must be a number ≥ 0');
  }
  if (Object.keys(updates).length === 0) return sendError(res, 400, 'No updatable field provided');

  try {
    const income = await service.updateIncome(req.params.id, updates, scope);
    if (!income) return sendNotFound(res, 'Income');
    return sendSuccess(res, 200, 'Income updated', income);
  } catch (err) {
    if (err.code === 'INVALID') return sendError(res, 400, err.message);
    if (err.code === 11000) return handleDuplicateKeyError(res, err);
    throw err;
  }
});

const deleteIncome = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid income id');
  const scope = scopeFor(req, res);
  if (scope === null) return undefined;

  const income = await service.deleteIncome(req.params.id, scope);
  if (!income) return sendNotFound(res, 'Income');
  return sendSuccess(res, 200, 'Income deleted', income);
});

module.exports = {
  createIncome,
  listIncomes,
  getIncome,
  updateIncome,
  deleteIncome,
};
