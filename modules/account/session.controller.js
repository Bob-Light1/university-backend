'use strict';
/** @file session.controller.js
 * @description HTTP adapter for session lifecycle operations.
 */
const service = require('./session.service');
const { sendSuccess, sendError, asyncHandler } = require('../../shared/utils/response-helpers');

/** Adapt session failures without leaking persistence or credential details. */
const action = (run) => asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const data = await run(req, res);
    return sendSuccess(res, 200, 'Session updated.', data ?? null);
  } catch (error) {
    return sendError(res, error.statusCode || 503,
      error.statusCode ? error.message : 'Authentication is temporarily unavailable.',
      error.code ? { code: error.code } : null);
  }
});

module.exports = {
  refresh: action(service.refresh),
  logout: action(service.logout),
  logoutAll: action((req, res) => service.logoutAll(req.user, res)),
  revokeCurrent: action(service.revokeCurrent),
  inspect: action(async (req) => ({ sessionId: req.user.sid })),
};
