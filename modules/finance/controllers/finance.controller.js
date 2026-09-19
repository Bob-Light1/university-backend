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

const crypto = require('crypto');

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

  try {
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
  } catch (err) {
    if (err.code === 'INVALID') return sendError(res, 400, err.message);
    throw err;
  }
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

/**
 * Streams the PDF receipt of one payment.
 *
 * ACCESS — two conditions, composed rather than chosen between:
 *   - the campus filter, for every role (a manager of campus A never reads a
 *     receipt of campus B);
 *   - AND, when the caller is the student, their own id — the platform's only
 *     other self-service finance route (`/my/ledger`) reads the same way, and
 *     campus alone would let a student download a classmate's receipt.
 *
 * A payment that exists but is out of scope answers 404, never 403: a 403 would
 * confirm the payment id exists, which is exactly what a probe is looking for.
 *
 * @route  GET /api/finance/payments/:id/receipt
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER | STUDENT (own payments)
 */
const getPaymentReceipt = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid payment id');
  const scope = scopeFor(req, res);
  if (scope === null) return undefined;

  if (req.user.role === 'STUDENT') scope.student = req.user.id;

  const receipt = await service.getPaymentReceipt(req.params.id, scope);
  if (!receipt) return sendNotFound(res, 'Payment');

  // A PDF stream, not the { success, data } envelope: the response body IS the
  // document (§4 covers JSON responses, and a base64 payload would double the
  // size of every receipt for no reader).
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${receipt.fileName}"`);
  res.setHeader('Content-Length', receipt.buffer.length);
  return res.end(receipt.buffer);
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

// ── Upload signature (supporting documents) ───────────────────────────────────

/**
 * Generate a short-lived Cloudinary signed upload token so the browser can
 * upload an income/expense supporting document directly to Cloudinary — only
 * the resulting secure_url is then stored in the record's `attachments[]`.
 *
 * @route  GET /api/finance/upload-signature
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const getUploadSignature = (_req, res) => {
  const timestamp = Math.round(Date.now() / 1000);
  const folder    = 'backend/finance';

  // Cloudinary signature: SHA-1( sorted_params + api_secret )
  const signature = crypto
    .createHash('sha1')
    .update(`folder=${folder}&timestamp=${timestamp}${process.env.CLOUDINARY_API_SECRET}`)
    .digest('hex');

  return sendSuccess(res, 200, 'Upload signature generated', {
    signature,
    timestamp,
    folder,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey:    process.env.CLOUDINARY_API_KEY,
  });
};

module.exports = {
  createFee,
  listFees,
  getFee,
  recordPayment,
  remindBalance,
  deleteFee,
  getPaymentReceipt,
  getStudentLedger,
  getMyLedger,
  getSummary,
  getUploadSignature,
};
