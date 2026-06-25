'use strict';

/**
 * @file account.routes.js
 * @description Account-activation router — mounted at /api/account.
 *
 * Public activation endpoints come first, then `authenticate` guards the
 * admin re-issue endpoint (CLAUDE.md §7).
 */

const express = require('express');
const router  = express.Router();

const accountController = require('./account.controller');
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

// ── PROTECTED ─────────────────────────────────────────────────────────────────
router.use(authenticate);

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
