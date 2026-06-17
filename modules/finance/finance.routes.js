'use strict';

/**
 * @file finance.routes.js — routes du suivi paiement étudiant (montées sur /api/finance).
 *
 * /my/ledger          → l'étudiant consulte son propre relevé.
 * /fees, /fees/:id…   → gestion (ADMIN / DIRECTOR / CAMPUS_MANAGER).
 * /students/:id/ledger→ relevé d'un étudiant (gestion).
 */

const express = require('express');
const router  = express.Router();

const ctrl = require('./controllers/finance.controller');
const { authenticate, authorize } = require('../../shared/middleware/auth');
const { apiLimiter } = require('../../shared/middleware/rate-limiter');

const MGMT_ROLES = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];

router.use(authenticate);

// ── Étudiant : son relevé (avant /fees pour éviter toute collision) ───────────
/**
 * @route GET /api/finance/my/ledger
 * @desc  Relevé (dettes + paiements + totaux) de l'étudiant courant
 * @access STUDENT
 */
router.get('/my/ledger', authorize(['STUDENT']), apiLimiter, ctrl.getMyLedger);

// ── Gestion des dettes ────────────────────────────────────────────────────────
/**
 * @route POST /api/finance/fees
 * @desc  Crée une dette pour un étudiant (notifie le solde en in-app)
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.post('/fees', authorize(MGMT_ROLES), apiLimiter, ctrl.createFee);

/**
 * @route GET /api/finance/fees
 * @desc  Liste paginée des dettes (filtres status/student/academicYear), scopée campus
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.get('/fees', authorize(MGMT_ROLES), apiLimiter, ctrl.listFees);

/**
 * @route GET /api/finance/fees/:id
 * @desc  Une dette et ses paiements
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.get('/fees/:id', authorize(MGMT_ROLES), apiLimiter, ctrl.getFee);

/**
 * @route POST /api/finance/fees/:id/payments
 * @desc  Impute un acompte sur une dette
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.post('/fees/:id/payments', authorize(MGMT_ROLES), apiLimiter, ctrl.recordPayment);

/**
 * @route POST /api/finance/fees/:id/remind
 * @desc  (Ré)envoie un rappel de solde à l'étudiant
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.post('/fees/:id/remind', authorize(MGMT_ROLES), apiLimiter, ctrl.remindBalance);

/**
 * @route DELETE /api/finance/fees/:id
 * @desc  Soft-delete d'une dette
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.delete('/fees/:id', authorize(MGMT_ROLES), apiLimiter, ctrl.deleteFee);

/**
 * @route GET /api/finance/students/:studentId/ledger
 * @desc  Relevé d'un étudiant donné (scopé campus)
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.get('/students/:studentId/ledger', authorize(MGMT_ROLES), apiLimiter, ctrl.getStudentLedger);

module.exports = router;
