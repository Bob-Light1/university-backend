'use strict';

/**
 * @file admin.router.js
 * @description Express router for platform-level Admin / Director accounts.
 *
 * Route matrix:
 *  POST   /api/admin/login               → loginAdmin            (public)
 *  POST   /api/admin/create              → createAdmin           (ADMIN only)
 *  GET    /api/admin/me                  → getMe                 (ADMIN | DIRECTOR)
 *  PATCH  /api/admin/me/password         → updatePassword        (ADMIN | DIRECTOR)
 *  PATCH  /api/admin/me/profile          → updateMyProfile       (ADMIN | DIRECTOR)
 *  PATCH  /api/admin/me/profile-image    → uploadProfileImage    (ADMIN | DIRECTOR)
 *  PATCH  /api/admin/me/notifications    → updateMyNotifications (ADMIN | DIRECTOR)
 *  GET    /api/admin/all                 → listAdmins            (ADMIN only)
 *  PATCH  /api/admin/:id/status          → updateAdminStatus     (ADMIN only)
 *  GET    /api/admin/campuses/:id/ai-entitlement → getCampusAiEntitlement    (ADMIN | DIRECTOR)
 *  PUT    /api/admin/campuses/:id/ai-entitlement → updateCampusAiEntitlement (ADMIN | DIRECTOR)
 *  GET    /api/admin/campuses/:id/entitlement    → getCampusEntitlement      (ADMIN | DIRECTOR)
 *  PATCH  /api/admin/campuses/:id/entitlement    → updateCampusEntitlement   (ADMIN | DIRECTOR)
 */

const express = require('express');

const {
  loginAdmin,
  createAdmin,
  getMe,
  updatePassword,
  updateMyProfile,
  uploadProfileImage,
  updateMyNotifications,
  getUploadSignature,
  listAdmins,
  updateAdminStatus,
} = require('./controllers/admin.controller');

const {
  getCampusAiEntitlement,
  updateCampusAiEntitlement,
} = require('./controllers/admin.ai-entitlement.controller');

const {
  getCampusEntitlement,
  updateCampusEntitlement,
} = require('./controllers/admin.entitlement.controller');

const { authenticate, authorize } = require('../../shared/middleware/auth');

const {
  loginLimiter,
  strictLimiter,
} = require('../../shared/middleware/rate-limiter');

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
 * PATCH /api/admin/me/password
 * Change own password (requires current password confirmation).
 */
router.patch(
  '/me/password',
  authenticate,
  authorize(['ADMIN', 'DIRECTOR']),
  updatePassword,
);

/**
 * PATCH /api/admin/me/profile
 * Update own display name.
 */
router.patch(
  '/me/profile',
  authenticate,
  authorize(['ADMIN', 'DIRECTOR']),
  updateMyProfile,
);

/**
 * PATCH /api/admin/me/profile-image
 * Store Cloudinary URL after client-side direct upload.
 * Body: { profileImageUrl: string }
 */
router.patch(
  '/me/profile-image',
  authenticate,
  authorize(['ADMIN', 'DIRECTOR']),
  uploadProfileImage,
);

/**
 * PATCH /api/admin/me/notifications
 * Update notification preferences.
 * Body: { email?: boolean, sms?: boolean, push?: boolean }
 */
router.patch(
  '/me/notifications',
  authenticate,
  authorize(['ADMIN', 'DIRECTOR']),
  updateMyNotifications,
);

/**
 * GET /api/admin/me/upload-signature
 * Cloudinary signed upload token for profile photo.
 */
router.get(
  '/me/upload-signature',
  authenticate,
  authorize(['ADMIN', 'DIRECTOR']),
  getUploadSignature,
);

/**
 * GET /api/admin/all
 * Paginated list of all Admin / Director accounts.
 * Query: role?, status?, search?, page?, limit?
 * ADMIN only — Directors cannot enumerate platform accounts.
 */
router.get(
  '/all',
  authenticate,
  authorize(['ADMIN']),
  listAdmins,
);

/**
 * GET /api/admin/campuses/:id/ai-entitlement
 * Current AI entitlement of a campus + recent audit entries (Phase 3, §11.3).
 */
router.get(
  '/campuses/:id/ai-entitlement',
  authenticate,
  authorize(['ADMIN', 'DIRECTOR']),
  getCampusAiEntitlement,
);

/**
 * PUT /api/admin/campuses/:id/ai-entitlement
 * Activate / update the AI entitlement of a campus (plan, budget, features,
 * LLM profile). Body: { enabled?, plan?, llmProfile?, monthlyTokenBudget?, features? }.
 * Appends an audit entry on every mutation (append-only).
 */
router.put(
  '/campuses/:id/ai-entitlement',
  authenticate,
  authorize(['ADMIN', 'DIRECTOR']),
  updateCampusAiEntitlement,
);

/**
 * GET /api/admin/campuses/:id/entitlement
 * Unified per-campus entitlement: effective state of every module, what the
 * plan alone grants, the override in force, and the recent audit entries
 * (CAMPUS_ENTITLEMENT_DESIGN.md §5 — the OFFER layer).
 */
router.get(
  '/campuses/:id/entitlement',
  authenticate,
  authorize(['ADMIN', 'DIRECTOR']),
  getCampusEntitlement,
);

/**
 * PATCH /api/admin/campuses/:id/entitlement
 * Sets the offer of a campus: plan and/or per-module overrides.
 * Body: { plan?, modules?: [{ key, state, until?, reason }] }.
 * Refuses (409) a change that would hide institutional records or a module
 * another collection still needs on this campus; appends an audit entry.
 */
router.patch(
  '/campuses/:id/entitlement',
  authenticate,
  authorize(['ADMIN', 'DIRECTOR']),
  updateCampusEntitlement,
);

/**
 * PATCH /api/admin/:id/status
 * Activate, deactivate or suspend an account.
 * Body: { status: 'active' | 'inactive' | 'suspended' }
 * ADMIN only — cannot target own account (enforced in controller).
 */
router.patch(
  '/:id/status',
  authenticate,
  authorize(['ADMIN']),
  updateAdminStatus,
);

module.exports = router;