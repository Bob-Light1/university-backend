'use strict';

/**
 * @file admin.router.js
 * @description Express router for platform-level Admin / Director accounts.
 *
 * Route matrix:
 *  POST   /api/admin/login            → loginAdmin          (public)
 *  POST   /api/admin/create           → createAdmin         (ADMIN only)
 *  GET    /api/admin/me               → getMe               (ADMIN | DIRECTOR)
 *  PUT    /api/admin/me/password      → updatePassword      (ADMIN | DIRECTOR)
 */

const express = require('express');

const {
  loginAdmin,
  createAdmin,
  getMe,
  updatePassword,
} = require('../controllers/admin.controller');

const { authenticate, authorize } = require('../middleware/auth/auth');

const {
  loginLimiter,
  strictLimiter,
} = require('../middleware/rate-limiter/rate-limiter');

const router = express.Router();

// ─── PUBLIC ───────────────────────────────────────────────────────────────────

/**
 * POST /api/admin/login
 * Authenticate an Admin or Director.
 * Rate-limited: 10 attempts per 15 minutes (loginLimiter).
 */
router.post('/login', loginLimiter, loginAdmin);

// ─── PROTECTED ────────────────────────────────────────────────────────────────

/**
 * POST /api/admin/create
 * - Bootstrap (DB empty)  : public — creates the very first admin.
 * - After setup           : requires an authenticated ADMIN (checked in controller).
 * - strictLimiter         : 3 attempts per hour (brute-force protection).
 */
router.post('/create', strictLimiter, createAdmin);

/**
 * GET /api/admin/me
 * Return the authenticated admin's own profile.
 */
router.get(
  '/me',
  authenticate,
  authorize(['ADMIN', 'DIRECTOR']),
  getMe,
);

/**
 * PUT /api/admin/me/password
 * Change own password (requires current password confirmation).
 */
router.put(
  '/me/password',
  authenticate,
  authorize(['ADMIN', 'DIRECTOR']),
  updatePassword,
);

module.exports = router;