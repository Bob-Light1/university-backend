'use strict';

/**
 * @file finance.routes.js — student payment tracking routes (mounted on /api/finance).
 *
 * /my/ledger          → the student views their own ledger.
 * /fees, /fees/:id…   → management (ADMIN / DIRECTOR / CAMPUS_MANAGER).
 * /students/:id/ledger→ a student's ledger (management).
 */

const express = require('express');
const router  = express.Router();

const ctrl = require('./controllers/finance.controller');
const { authenticate, authorize } = require('../../shared/middleware/auth');
const { apiLimiter } = require('../../shared/middleware/rate-limiter');

const MGMT_ROLES = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];

router.use(authenticate);

// ── Student: their ledger (before /fees to avoid any collision) ───────────────
/**
 * @route GET /api/finance/my/ledger
 * @desc  Ledger (debts + payments + totals) of the current student
 * @access STUDENT
 */
router.get('/my/ledger', authorize(['STUDENT']), apiLimiter, ctrl.getMyLedger);

// ── Debt management ───────────────────────────────────────────────────────────
/**
 * @route POST /api/finance/fees
 * @desc  Creates a debt for a student (notifies the balance in-app)
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.post('/fees', authorize(MGMT_ROLES), apiLimiter, ctrl.createFee);

/**
 * @route GET /api/finance/fees
 * @desc  Paginated list of debts (filters status/student/academicYear), campus-scoped
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.get('/fees', authorize(MGMT_ROLES), apiLimiter, ctrl.listFees);

/**
 * @route GET /api/finance/fees/:id
 * @desc  A debt and its payments
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.get('/fees/:id', authorize(MGMT_ROLES), apiLimiter, ctrl.getFee);

/**
 * @route POST /api/finance/fees/:id/payments
 * @desc  Applies a payment to a debt
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.post('/fees/:id/payments', authorize(MGMT_ROLES), apiLimiter, ctrl.recordPayment);

/**
 * @route POST /api/finance/fees/:id/remind
 * @desc  (Re)sends a balance reminder to the student
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.post('/fees/:id/remind', authorize(MGMT_ROLES), apiLimiter, ctrl.remindBalance);

/**
 * @route DELETE /api/finance/fees/:id
 * @desc  Soft-delete of a debt
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.delete('/fees/:id', authorize(MGMT_ROLES), apiLimiter, ctrl.deleteFee);

/**
 * @route GET /api/finance/students/:studentId/ledger
 * @desc  Ledger of a given student (campus-scoped)
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.get('/students/:studentId/ledger', authorize(MGMT_ROLES), apiLimiter, ctrl.getStudentLedger);

module.exports = router;
