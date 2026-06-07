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

const campusCtrl              = require('../controllers/public/public.campus.controller');
const registerCtrl            = require('../controllers/public/public.register.controller');
const quizCtrl                = require('../controllers/public/public.quiz.controller');
const leaderboardCtrl         = require('../controllers/public/public.leaderboard.controller');
const programsCtrl            = require('../controllers/public/public.programs.controller');
const testimonialsCtrl        = require('../controllers/public/public.testimonials.controller');
const faqCtrl                 = require('../controllers/public/public.faq.controller');
const competitionCtrl         = require('../controllers/public/public.competition.controller');
const coursesCtrl             = require('../controllers/public/public.courses.controller');
const contactCtrl             = require('../controllers/public/public.contact.controller');
const partnerApplicationCtrl  = require('../controllers/public/public.partner.application.controller');
const alertCtrl               = require('../controllers/public/public.alert.controller');

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

// ── TÉMOIGNAGES (Phase 2) ─────────────────────────────────────────────────────
// GET /api/public/testimonials?campusSlug=...&limit=6
router.get('/testimonials', testimonialsCtrl.getTestimonials);

// ── FAQ (Phase 2 — cache 24h côté portail) ────────────────────────────────────
// GET /api/public/faq?campusSlug=...
router.get('/faq', faqCtrl.getFaq);

// ── COMPÉTITION (Phase 2) ─────────────────────────────────────────────────────
// GET /api/public/competition/prizes?campusSlug=...
router.get('/competition/prizes', competitionCtrl.getCompetitionPrizes);

// ── APERÇUS DE COURS (Phase 2) ────────────────────────────────────────────────
// GET /api/public/course-previews?campusSlug=...&program=...
router.get('/course-previews', coursesCtrl.getCoursePreviews);

// ── CONTACT (Phase 3) ─────────────────────────────────────────────────────────
// POST /api/public/contact
const contactLimiter = createCustomLimiter(
  60,
  5,
  'Too many contact submissions from this IP. Please try again in 1 hour.'
);
router.post('/contact', contactLimiter, contactCtrl.submitContact);

// ── CANDIDATURE PARTENAIRE (Phase 3) ──────────────────────────────────────────
// POST /api/public/partner-application
const partnerApplicationLimiter = createCustomLimiter(
  60,
  3,
  'Too many partner applications from this IP. Please try again in 1 hour.'
);
router.post('/partner-application', partnerApplicationLimiter, partnerApplicationCtrl.submitPartnerApplication);

// POST /api/public/alert — session alert opt-in (spec §4.13)
const alertLimiter = createCustomLimiter(60, 5, 'Too many alert registrations from this IP. Please try again later.');
router.post('/alert', alertLimiter, alertCtrl.submitAlert);

module.exports = router;
