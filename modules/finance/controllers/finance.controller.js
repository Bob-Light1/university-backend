'use strict';

/**
 * @file finance.controller.js — HTTP layer of student payment tracking.
 *
 * Surfaces:
 *   - management (MGMT): create a debt, list, view, apply a payment,
 *     send a reminder, delete, a student's ledger;
 *   - student: their own ledger.
 *
 * No Mongoose query here — everything goes through finance.service. Campus
 * scoping is derived from the JWT via buildCampusFilter (anti cross-campus leak).
 */

const service = require('../finance.service');
const {
  asyncHandler,
  sendSuccess,
  sendCreated,
  sendError,
  sendNotFound,
  sendForbidden,
  sendPaginated,
} = require('../../../shared/utils/response-helpers');
const { isValidObjectId, buildCampusFilter } = require('../../../shared/utils/validation-helpers');
const { STATUSES } = require('../fee-status');

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

// ── Management (MGMT) ─────────────────────────────────────────────────────────

const createFee = asyncHandler(async (req, res) => {
  const { student, label, amountDue, currency, dueDate, academicYear, notes } = req.body;

  if (!isValidObjectId(student)) return sendError(res, 400, 'A valid student id is required');
  if (!label || !String(label).trim()) return sendError(res, 400, 'label is required');
  if (amountDue === undefined || Number(amountDue) < 0 || !Number.isFinite(Number(amountDue))) {
    return sendError(res, 400, 'amountDue must be a number ≥ 0');
  }

  // Campus: enforced by the JWT for local roles; required in the body for global ones.
  let schoolCampus;
  if (GLOBAL_ROLES.includes(req.user.role)) {
    schoolCampus = req.body.schoolCampus;
    if (!isValidObjectId(schoolCampus)) {
      return sendError(res, 400, 'schoolCampus is required for global roles');
    }
  } else {
    schoolCampus = req.user.campusId;
    if (!isValidObjectId(String(schoolCampus))) return sendForbidden(res, 'No campus bound to your account');
  }

  const fee = await service.createFee({
    student,
    schoolCampus,
    label: String(label).trim(),
    academicYear,
    amountDue: Number(amountDue),
    currency,
    dueDate: dueDate || null,
    notes,
    createdBy: req.user.id,
  });

  return sendCreated(res, 'Fee created', fee);
});

const listFees = asyncHandler(async (req, res) => {
  const scope = scopeFor(req, res);
  if (scope === null) return undefined;

  const page  = parseInt(req.query.page, 10) || 1;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

  const filter = { ...scope };
  if (req.query.status) {
    if (!STATUSES.includes(req.query.status)) {
      return sendError(res, 400, `status must be one of: ${STATUSES.join(', ')}`);
    }
    filter.status = req.query.status;
  }
  if (isValidObjectId(req.query.student)) filter.student = req.query.student;
  if (req.query.academicYear) filter.academicYear = req.query.academicYear;

  const { data, total } = await service.listFees({ filter, skip: (page - 1) * limit, limit });
  return sendPaginated(res, 200, 'Fees', data, { total, page, limit });
});

const getFee = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid fee id');
  const scope = scopeFor(req, res);
  if (scope === null) return undefined;

  const result = await service.getFeeWithPayments(req.params.id, scope);
  if (!result) return sendNotFound(res, 'Fee');
  return sendSuccess(res, 200, 'Fee', result);
});

const recordPayment = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid fee id');
  const scope = scopeFor(req, res);
  if (scope === null) return undefined;

  const { amount, method, reference, paidAt, notes } = req.body;
  try {
    const result = await service.recordPayment({
      feeId: req.params.id,
      amount,
      method,
      reference,
      paidAt,
      notes,
      recordedBy: req.user.id,
      scope,
    });
    return sendCreated(res, 'Payment recorded', result);
  } catch (err) {
    if (err.code === 'NOT_FOUND') return sendNotFound(res, 'Fee');
    if (err.code === 'INVALID') return sendError(res, 400, err.message);
    throw err;
  }
});

const remindBalance = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid fee id');
  const scope = scopeFor(req, res);
  if (scope === null) return undefined;

  const fee = await service.remindBalance(req.params.id, scope);
  if (!fee) return sendNotFound(res, 'Fee');
  return sendSuccess(res, 200, 'Reminder sent', fee);
});

const deleteFee = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid fee id');
  const scope = scopeFor(req, res);
  if (scope === null) return undefined;

  const fee = await service.deleteFee(req.params.id, scope);
  if (!fee) return sendNotFound(res, 'Fee');
  return sendSuccess(res, 200, 'Fee deleted', fee);
});

const getStudentLedger = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.studentId)) return sendError(res, 400, 'Invalid student id');
  const scope = scopeFor(req, res);
  if (scope === null) return undefined;

  const ledger = await service.getStudentLedger(req.params.studentId, scope);
  return sendSuccess(res, 200, 'Student ledger', ledger);
});

// ── Financial summary (income vs expense) ─────────────────────────────────────

const getSummary = asyncHandler(async (req, res) => {
  const scope = scopeFor(req, res);
  if (scope === null) return undefined;

  const period = {};
  if (req.query.year) period.year = parseInt(req.query.year, 10);
  if (req.query.month) period.month = parseInt(req.query.month, 10);

  const summary = await service.getFinancialSummary(scope, period);
  return sendSuccess(res, 200, 'Financial summary', summary);
});

// ── Student: their own ledger ─────────────────────────────────────────────────

const getMyLedger = asyncHandler(async (req, res) => {
  const scope = {};
  if (req.user.campusId) scope.schoolCampus = req.user.campusId;
  const ledger = await service.getStudentLedger(req.user.id, scope);
  return sendSuccess(res, 200, 'My ledger', ledger);
});

module.exports = {
  createFee,
  listFees,
  getFee,
  recordPayment,
  remindBalance,
  deleteFee,
  getStudentLedger,
  getMyLedger,
  getSummary,
};
