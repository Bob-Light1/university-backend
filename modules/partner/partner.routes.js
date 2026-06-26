'use strict';

/**
 * @file partner.router.js
 * @description Routes for the Partner module.
 *
 * Base path   : /api/partners  (registered in server.js)
 * Base public : /api/partners/public (no authentication)
 *
 * Campus isolation: campusId NEVER in the URL — always from the JWT.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

const { authenticate, authorize } = require('../../shared/middleware/auth');
const { loginLimiter, strictLimiter, createCustomLimiter } = require('../../shared/middleware/rate-limiter');

const authCtrl       = require('./controllers/partner.auth.controller');
const crudCtrl       = require('./controllers/partner.crud.controller');
const leadCtrl       = require('./controllers/partner.lead.controller');
const commissionCtrl = require('./controllers/partner.commission.controller');

const router = express.Router();

// Rate limiter dedicated to pre-registration: 10 req/h/IP (spec v2.0 §3.6)
const preRegisterLimiter = createCustomLimiter(60, 10, 'Too many pre-registration attempts. Please try again in 1 hour.');

// Rate limiter for the referral-hit beacon: 60 hits/min/IP. Generous enough for
// real scans/clicks while bounding how far a bot can inflate the counters.
const trackLimiter = createCustomLimiter(1, 60, 'Too many requests.');

// Rate limiter for code resolution: 30/min/IP — deters partnerCode enumeration.
const resolveLimiter = createCustomLimiter(1, 30, 'Too many requests.');

const MGR_ROLES    = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];
const PARTNER_ROLE = ['PARTNER'];

// ── PUBLIC ROUTES (no authentication) ───────────────────────────────────

router.post('/auth/login',           loginLimiter,     authCtrl.login);
router.post('/auth/forgot-password', strictLimiter,    authCtrl.forgotPassword);
router.post('/auth/reset-password/:token',             authCtrl.resetPassword);

// Prospect pre-registration
router.post('/public/pre-register', preRegisterLimiter, leadCtrl.publicPreRegister);

// Resolve partnerCode → campus branding
router.get('/public/resolve/:code', resolveLimiter, leadCtrl.resolveCode);

// Live referral QR (PNG) — public, generated on the fly (usable as <img> src)
router.get('/public/qr/:code', leadCtrl.streamReferralQr);

// Referral hit tracking (scan/click) — public beacon from the portal redirector
router.post('/public/track/:code', trackLimiter, leadCtrl.trackReferralHit);

// ── PARTNER PORTAL ROUTES ─────────────────────────────────────────────────────
// All these routes require a valid JWT with role PARTNER

router.get(
  '/me',
  authenticate,
  authorize(PARTNER_ROLE),
  authCtrl.getMe
);

router.put(
  '/me/profile',
  authenticate,
  authorize(PARTNER_ROLE),
  authCtrl.updateMyProfile
);

router.put(
  '/me/password',
  authenticate,
  authorize(PARTNER_ROLE),
  authCtrl.changeMyPassword
);

router.post(
  '/me/profile-image',
  authenticate,
  authorize(PARTNER_ROLE),
  authCtrl.uploadProfileImage
);

router.get(
  '/me/dashboard',
  authenticate,
  authorize(PARTNER_ROLE),
  commissionCtrl.getPartnerDashboard
);

router.get(
  '/me/leads',
  authenticate,
  authorize(PARTNER_ROLE),
  leadCtrl.listLeads
);

router.get(
  '/me/commissions',
  authenticate,
  authorize(PARTNER_ROLE),
  commissionCtrl.listCommissions
);

router.get(
  '/me/commissions/:id/receipt',
  authenticate,
  authorize(PARTNER_ROLE),
  commissionCtrl.downloadReceipt
);

router.get(
  '/me/kit',
  authenticate,
  authorize(PARTNER_ROLE),
  crudCtrl.downloadKit
);

// ── CAMPUS MANAGER — PARTNER CRUD ────────────────────────────────────────────

router.post(
  '/auth/register',
  authenticate,
  authorize(MGR_ROLES),
  authCtrl.register
);

router.get(
  '/export',
  authenticate,
  authorize(MGR_ROLES),
  crudCtrl.exportPartners
);

router.get(
  '/',
  authenticate,
  authorize(MGR_ROLES),
  crudCtrl.listPartners
);

// ── CAMPUS MANAGER — LEADS ────────────────────────────────────────────────────
// Declared BEFORE /:id to prevent Express from matching /leads against /:id.

router.get(
  '/leads/export',
  authenticate,
  authorize(MGR_ROLES),
  leadCtrl.exportLeads
);

router.get(
  '/leads',
  authenticate,
  authorize(MGR_ROLES),
  leadCtrl.listLeads
);

router.get(
  '/leads/:id',
  authenticate,
  authorize(MGR_ROLES),
  leadCtrl.getLead
);

router.patch(
  '/leads/:id/status',
  authenticate,
  authorize(MGR_ROLES),
  leadCtrl.updateLeadStatus
);

router.delete(
  '/leads/:id',
  authenticate,
  authorize(MGR_ROLES),
  leadCtrl.deleteLead
);

// ── CAMPUS MANAGER — COMMISSIONS ──────────────────────────────────────────────
// Declared BEFORE /:id for the same reason.

router.get(
  '/commissions/export',
  authenticate,
  authorize(MGR_ROLES),
  commissionCtrl.exportCommissions
);

router.get(
  '/commissions',
  authenticate,
  authorize(MGR_ROLES),
  commissionCtrl.listCommissions
);

router.patch(
  '/commissions/:id/validate',
  authenticate,
  authorize(MGR_ROLES),
  commissionCtrl.validateCommission
);

router.patch(
  '/commissions/:id/pay',
  authenticate,
  authorize(MGR_ROLES),
  commissionCtrl.markPaid
);

router.patch(
  '/commissions/:id/dispute',
  authenticate,
  authorize(MGR_ROLES),
  commissionCtrl.disputeCommission
);

router.patch(
  '/commissions/:id/cancel',
  authenticate,
  authorize(MGR_ROLES),
  commissionCtrl.cancelCommission
);

router.get(
  '/commission-config',
  authenticate,
  authorize(MGR_ROLES),
  commissionCtrl.getCommissionConfig
);

router.put(
  '/commission-config',
  authenticate,
  authorize(MGR_ROLES),
  commissionCtrl.updateCommissionConfig
);

// ── :id ROUTES — declare LAST so they don't mask the named routes ──

router.get(
  '/:id',
  authenticate,
  authorize(MGR_ROLES),
  crudCtrl.getPartner
);

router.put(
  '/:id',
  authenticate,
  authorize(MGR_ROLES),
  crudCtrl.updatePartner
);

router.patch(
  '/:id/status',
  authenticate,
  authorize(MGR_ROLES),
  crudCtrl.toggleStatus
);

router.delete(
  '/:id',
  authenticate,
  authorize(MGR_ROLES),
  crudCtrl.archivePartner
);

router.patch(
  '/:id/restore',
  authenticate,
  authorize(MGR_ROLES),
  crudCtrl.restorePartner
);

router.get(
  '/:id/kit',
  authenticate,
  authorize(MGR_ROLES),
  crudCtrl.downloadKit
);

router.get(
  '/:id/commission-summary',
  authenticate,
  authorize(MGR_ROLES),
  crudCtrl.getCommissionSummary
);

module.exports = router;
