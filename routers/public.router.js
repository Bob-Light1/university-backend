'use strict';

/**
 * @file public.router.js
 * @description Routes publiques du portail de pré-inscription.
 *
 * Base path : /api/public  (monté dans server.js AVANT les middlewares JWT)
 *
 * Toutes les routes passent par publicPortalMiddleware qui :
 *  1. Vérifie le header X-Portal-Key
 *  2. Hache l'IP (req.ipHash) — jamais l'IP brute en DB
 *
 * Rate limiting spécifique pré-inscription : 10 req/h/IP (createCustomLimiter).
 */

const express = require('express');

const publicPortalMiddleware = require('../middleware/public-portal/publicPortal.middleware');
const { createCustomLimiter } = require('../middleware/rate-limiter/rate-limiter');

const campusCtrl      = require('../controllers/public/public.campus.controller');
const registerCtrl    = require('../controllers/public/public.register.controller');
const quizCtrl        = require('../controllers/public/public.quiz.controller');
const leaderboardCtrl = require('../controllers/public/public.leaderboard.controller');
const programsCtrl    = require('../controllers/public/public.programs.controller');

const router = express.Router();

// Toutes les routes /api/public/* passent par ce middleware
router.use(publicPortalMiddleware);

// Rate limiter dédié pré-inscription : 10 req/h/IP (spec §5.5)
const preRegisterLimiter = createCustomLimiter(
  60,
  10,
  'Too many pre-registration attempts from this IP. Please try again in 1 hour.'
);

// ── CAMPUS ────────────────────────────────────────────────────────────────────
// GET /api/public/campus-info?ref=PARTNER_CODE
// GET /api/public/campus-info?slug=CAMPUS_SLUG
router.get('/campus-info', campusCtrl.getCampusInfo);

// GET /api/public/campuses — public campus list for the selection page
router.get('/campuses', campusCtrl.listCampuses);

// ── PRÉ-INSCRIPTION ───────────────────────────────────────────────────────────
// POST /api/public/pre-register
router.post('/pre-register', preRegisterLimiter, registerCtrl.publicPreRegister);

// ── FORMATIONS ────────────────────────────────────────────────────────────────
// GET /api/public/programs?campusSlug=...
router.get('/programs', programsCtrl.getPrograms);

// ── QUIZ ──────────────────────────────────────────────────────────────────────
// GET  /api/public/quiz?campusSlug=...&category=...&limit=10
// POST /api/public/quiz/submit
router.get('/quiz',        quizCtrl.getQuizQuestions);
router.post('/quiz/submit', quizCtrl.submitQuiz);

// ── CLASSEMENT ────────────────────────────────────────────────────────────────
// GET /api/public/leaderboard?campusSlug=...&period=YYYY-MM&category=...&scope=campus
router.get('/leaderboard', leaderboardCtrl.getLeaderboard);

module.exports = router;
