'use strict';

/**
 * @file account.routes.js
 * @description Account activation and session router — mounted at /api/account.
 *
 * Public activation endpoints come first, then `authenticate` guards the
 * session inspection/revocation and admin re-issue endpoints (CLAUDE.md §7).
 */

const express = require('express');
const router  = express.Router();

const accountController = require('./account.controller');
const sessionController = require('./session.controller');
const { authenticate, authorize } = require('../../shared/middleware/auth');
const { loginLimiter, apiLimiter } = require('../../shared/middleware/rate-limiter');

// ── PUBLIC ──────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/account/activate/:token
 * @desc   Validate an activation link before rendering the password form
 * @access Public
 */
router.get('/activate/:token', apiLimiter, accountController.inspectActivation);

/**
 * @route  POST /api/account/activate
 * @desc   Set the user-chosen password and activate the account
 * @access Public
 */
router.post('/activate', loginLimiter, accountController.activate);

/** @route POST /api/account/session/refresh
 * @desc Rotate a refresh credential.
 * @access Public, refresh cookie and CSRF header required.
 */
router.post('/session/refresh', apiLimiter, sessionController.refresh);
/** @route POST /api/account/session/logout
 * @desc Revoke a session, even after access expiry.
 * @access Refresh cookie and CSRF header.
 */
router.post('/session/logout', apiLimiter, sessionController.logout);

// ── PROTECTED ─────────────────────────────────────────────────────────────────
router.use(authenticate);

/** @route GET /api/account/session
 * @desc Verify the current server session.
 * @access Authenticated.
 */
router.get('/session', apiLimiter, sessionController.inspect);
/** @route POST /api/account/session/revoke
 * @desc Revoke the bearer-authenticated session.
 * @access Authenticated.
 */
router.post('/session/revoke', apiLimiter, sessionController.revokeCurrent);
/** @route POST /api/account/session/logout-all
 * @desc Revoke all sessions of the caller.
 * @access Authenticated.
 */
router.post('/session/logout-all', apiLimiter, sessionController.logoutAll);

/**
 * @route  POST /api/account/:model/:id/resend
 * @desc   Re-issue an activation token for a still-pending account
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.post(
  '/:model/:id/resend',
  authorize(accountController.MGMT_ROLES),
  accountController.resendActivation
);

module.exports = router;
