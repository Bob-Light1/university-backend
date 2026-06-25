'use strict';

/**
 * @file account.controller.js
 * @description Public account-activation endpoints + admin re-issue.
 *
 *  GET  /api/account/activate/:token         → inspectActivation   (public)
 *  POST /api/account/activate                → activate            (public)
 *  POST /api/account/:model/:id/resend       → resendActivation    (ADMIN | DIRECTOR | CAMPUS_MANAGER)
 */

const mongoose = require('mongoose');

const accountService  = require('./account.service');
const ActivationToken = require('./account.activation.model');
const {
  sendSuccess,
  sendError,
  sendNotFound,
  sendValidationError,
  asyncHandler,
} = require('../../shared/utils/response-helpers');
const { isValidObjectId } = require('../../shared/utils/validation-helpers');

const MGMT_ROLES = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];

// Maps the public :model path segment to a registered mongoose model name.
const MODEL_BY_SLUG = Object.freeze({
  mentors:  'Mentor',
  staff:    'Staff',
  students: 'Student',
  teachers: 'Teacher',
  parents:  'Parent',
});

/**
 * GET /api/account/activate/:token
 * Validates a link token so the frontend can render the password form.
 */
const inspectActivation = asyncHandler(async (req, res) => {
  const info = await accountService.inspectToken(req.params.token);
  if (!info) {
    return sendError(res, 410, 'This activation link is invalid or has expired.');
  }
  return sendSuccess(res, 200, 'Activation link is valid.', info);
});

/**
 * POST /api/account/activate
 * Body: { token, password } | { identifier, code, password }
 * Sets the user-chosen password and activates the account.
 */
const activate = asyncHandler(async (req, res) => {
  const { token, identifier, code, password } = req.body || {};

  if (!password) {
    return sendValidationError(res, [{ field: 'password', message: 'Password is required.' }]);
  }
  if (!token && !(identifier && code)) {
    return sendValidationError(res, [
      { field: 'token', message: 'An activation link, or an identifier and code, is required.' },
    ]);
  }

  try {
    await accountService.activateAccount({ token, identifier, code, password });
    return sendSuccess(res, 200, 'Your account has been activated. You can now sign in.');
  } catch (err) {
    switch (err.code) {
      case 'WEAK_PASSWORD':
        return sendValidationError(res, (err.errors || []).map((m) => ({ field: 'password', message: m })));
      case 'MISSING_CREDENTIALS':
        return sendValidationError(res, [{ field: 'token', message: err.message }]);
      case 'INVALID_OR_EXPIRED':
        return sendError(res, 410, err.message);
      case 'IDENTIFIER_MISMATCH':
        return sendError(res, 401, err.message);
      case 'TOO_MANY_ATTEMPTS':
        return sendError(res, 429, err.message);
      default:
        console.error('❌ activate error:', err);
        return sendError(res, 500, 'Failed to activate the account.');
    }
  }
});

/**
 * POST /api/account/:model/:id/resend
 * Re-issues an activation token for an account that has not activated yet.
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const resendActivation = asyncHandler(async (req, res) => {
  const userModel = MODEL_BY_SLUG[req.params.model];
  const { id } = req.params;

  if (!userModel) return sendNotFound(res, 'Account type');
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid account ID format.');

  const Model = mongoose.model(userModel);
  const account = await Model.findById(id).select('firstName email schoolCampus status preferredLanguage');
  if (!account) return sendNotFound(res, userModel);

  // Campus isolation: a CAMPUS_MANAGER may only act on their own campus.
  if (!['ADMIN', 'DIRECTOR'].includes(req.user.role)) {
    const accountCampus = account.schoolCampus ? String(account.schoolCampus) : null;
    if (!req.user.campusId || accountCampus !== String(req.user.campusId)) {
      return sendError(res, 403, 'You cannot manage an account from another campus.');
    }
  }

  if (account.status !== 'pending') {
    return sendError(res, 409, 'This account is already activated.');
  }

  const { activationUrl, code, expiresAt } = await accountService.issueActivationToken({
    userModel,
    userId:    account._id,
    campusId:  account.schoolCampus || null,
    email:     account.email || null,
    name:      account.firstName || '',
    locale:    account.preferredLanguage,
    createdBy: req.user.id,
  });

  return sendSuccess(res, 200, 'Activation link re-issued.', { activationUrl, code, expiresAt });
});

module.exports = {
  inspectActivation,
  activate,
  resendActivation,
  MGMT_ROLES,
};
