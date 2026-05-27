'use strict';

/**
 * @file partner.router.js
 * @description Routes du module Partner.
 *
 * Base path   : /api/partners  (enregistré dans server.js)
 * Base public : /api/partners/public (pas d'authentification)
 *
 * Isolation campus : campusId JAMAIS dans l'URL — toujours depuis JWT.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

const { authenticate, authorize } = require('../middleware/auth/auth');
const { loginLimiter, strictLimiter, createCustomLimiter } = require('../middleware/rate-limiter/rate-limiter');

const authCtrl       = require('../controllers/partner-controllers/partner.auth.controller');
const crudCtrl       = require('../controllers/partner-controllers/partner.crud.controller');
const leadCtrl       = require('../controllers/partner-controllers/partner.lead.controller');
const commissionCtrl = require('../controllers/partner-controllers/partner.commission.controller');

const router = express.Router();

// Rate limiter dédié pré-inscription : 10 req/h/IP (spec v2.0 §3.6)
const preRegisterLimiter = createCustomLimiter(60, 10, 'Too many pre-registration attempts. Please try again in 1 hour.');

const MGR_ROLES    = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];
const PARTNER_ROLE = ['PARTNER'];

// ── PUBLIC ROUTES (pas d'authentification) ───────────────────────────────────

router.post('/auth/login',           loginLimiter,     authCtrl.login);
router.post('/auth/forgot-password', strictLimiter,    authCtrl.forgotPassword);
router.post('/auth/reset-password/:token',             authCtrl.resetPassword);

// Pré-inscription prospect
router.post('/public/pre-register', preRegisterLimiter, leadCtrl.publicPreRegister);

// Résolution du partnerCode → branding campus
router.get('/public/resolve/:code', leadCtrl.resolveCode);

// ── PARTNER PORTAL ROUTES ─────────────────────────────────────────────────────
// Toutes ces routes requièrent un JWT valide avec role PARTNER

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
// Déclarées AVANT /:id pour éviter que Express ne matche /leads contre /:id.

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
// Déclarées AVANT /:id pour la même raison.

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
  authorize(['ADMIN', 'CAMPUS_MANAGER']),
  commissionCtrl.updateCommissionConfig
);

// ── ROUTES PAR :id — à déclarer EN DERNIER pour ne pas masquer les routes nommées ──

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
  authorize(['ADMIN', 'CAMPUS_MANAGER']),
  crudCtrl.archivePartner
);

router.patch(
  '/:id/restore',
  authenticate,
  authorize(['ADMIN', 'CAMPUS_MANAGER']),
  crudCtrl.restorePartner
);

router.post(
  '/:id/qr-code',
  authenticate,
  authorize(MGR_ROLES),
  crudCtrl.regenerateQR
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
