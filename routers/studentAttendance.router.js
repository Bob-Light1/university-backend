'use strict';

/**
 * @file studentAttendance.router.js
 * @description Express router for student attendance endpoints.
 *
 *  Base path (registered in server.js):
 *    /api/attendance/student
 *
 *  Alignements avec le backend foruni :
 *  ──────────────────────────────────────
 *  • Middleware : authenticate + authorize() depuis '../middleware/auth/auth'
 *    (PAS protect() ni campusIsolation)
 *  • Rôles : 'ADMIN' | 'DIRECTOR' | 'CAMPUS_MANAGER' | 'TEACHER' | 'STUDENT'
 *  • DIRECTOR traité comme ADMIN dans les autorisations
 *  • Campus isolation gérée dans les controllers via req.user.campusId
 *  • apiLimiter depuis '../middleware/rate-limiter/rate-limiter'
 *
 *  Hiérarchie des rôles dans ce fichier :
 *  ────────────────────────────────────────
 *  ADMIN / DIRECTOR      – lecture cross-campus + analytics
 *  CAMPUS_MANAGER        – contrôle total sur leur campus
 *  TEACHER               – opérations d'appel sur leurs séances
 *  STUDENT               – lecture seule sur ses propres données
 */

const express = require('express');
const router  = express.Router();

const { authenticate, authorize } = require('../middleware/auth/auth');
const { apiLimiter }              = require('../middleware/rate-limiter/rate-limiter');

const {
  initSessionAttendance,
  getSessionAttendance,
  submitAttendance,
  toggleStudentStatus,
  justifyAbsence,
  lockDailyAttendance,
  getMyAttendance,
  getMyStats,
  getStudentStats,
  getClassStats,
  getCampusOverview,
} = require('../controllers/student-controllers/studentAttendance.controller');

// ─────────────────────────────────────────────
// MIDDLEWARE GLOBAL
// Toutes les routes d'attendance requièrent une authentification.
// ─────────────────────────────────────────────
router.use(authenticate);
router.use(apiLimiter);

// ─────────────────────────────────────────────
// SELF-SERVICE ÉTUDIANT
// ─────────────────────────────────────────────

/**
 * GET /api/attendance/student/me
 * Historique de présence de l'étudiant connecté.
 * Query : academicYear (requis), semester (requis), from?, to?
 */
router.get(
  '/me',
  authorize(['STUDENT']),
  getMyAttendance
);

/**
 * GET /api/attendance/student/me/stats
 * Statistiques de présence de l'étudiant connecté.
 * Query : academicYear (requis), semester (requis), period (all|month|week)
 */
router.get(
  '/me/stats',
  authorize(['STUDENT']),
  getMyStats
);

// ─────────────────────────────────────────────
// ROUTES AU NIVEAU DE LA SÉANCE (TEACHER / CAMPUS_MANAGER)
// ─────────────────────────────────────────────

/**
 * POST /api/attendance/student/sessions/:scheduleId/init
 * Initialise la feuille de présence pour tous les étudiants inscrits.
 * Body : { classId, attendanceDate, academicYear, semester,
 *           sessionStartTime?, sessionEndTime? }
 */
router.post(
  '/sessions/:scheduleId/init',
  authorize(['CAMPUS_MANAGER', 'TEACHER', 'ADMIN', 'DIRECTOR']),
  initSessionAttendance
);

/**
 * GET /api/attendance/student/sessions/:scheduleId
 * Feuille d'appel complète pour une séance.
 * Query : date?, classId?
 */
router.get(
  '/sessions/:scheduleId',
  authorize(['CAMPUS_MANAGER', 'TEACHER', 'ADMIN', 'DIRECTOR']),
  getSessionAttendance
);

/**
 * PATCH /api/attendance/student/sessions/:scheduleId/submit
 * Verrouille tous les enregistrements d'une séance (irréversible).
 * Body : { attendanceDate, classId? }
 */
router.patch(
  '/sessions/:scheduleId/submit',
  authorize(['CAMPUS_MANAGER', 'TEACHER', 'ADMIN', 'DIRECTOR']),
  submitAttendance
);

// ─────────────────────────────────────────────
// ROUTES ADMINISTRATIVES
// ─────────────────────────────────────────────

/**
 * PATCH /api/attendance/student/lock-daily
 * Verrouille toutes les présences étudiantes d'une date sur le campus.
 * Body : { date? } – défaut : aujourd'hui
 */
router.patch(
  '/lock-daily',
  authorize(['CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  lockDailyAttendance
);


// ─────────────────────────────────────────────
// ROUTES SUR UN ENREGISTREMENT INDIVIDUEL
// ─────────────────────────────────────────────

/**
 * PATCH /api/attendance/student/:attendanceId/toggle
 * Marque un étudiant comme présent ou absent (enregistrement non verrouillé).
 * Body : { status: boolean }
 */
router.patch(
  '/:attendanceId/toggle',
  authorize(['CAMPUS_MANAGER', 'TEACHER', 'ADMIN', 'DIRECTOR']),
  toggleStudentStatus
);

/**
 * PATCH /api/attendance/student/:attendanceId/justify
 * Ajoute ou met à jour la justification d'une absence.
 * Body : { justification (string), justificationDocument? (URL) }
 */
router.patch(
  '/:attendanceId/justify',
  authorize(['CAMPUS_MANAGER', 'TEACHER', 'ADMIN', 'DIRECTOR']),
  justifyAbsence
);

// ─────────────────────────────────────────────
// ROUTES ANALYTICS
// ─────────────────────────────────────────────

/**
 * GET /api/attendance/student/campus/overview
 * Liste paginée de tous les enregistrements du campus.
 * Query : from, to, classId?, status (true|false|all), page, limit
 */
router.get(
  '/campus/overview',
  authorize(['CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  getCampusOverview
);

/**
 * GET /api/attendance/student/class/:classId/stats
 * Statistiques agrégées de présence pour une classe.
 * Query : date?, period (day|week|month|year)
 */
router.get(
  '/class/:classId/stats',
  authorize(['CAMPUS_MANAGER', 'TEACHER', 'ADMIN', 'DIRECTOR']),
  getClassStats
);

/**
 * GET /api/attendance/student/:studentId/stats
 * Statistiques de présence pour un étudiant spécifique.
 * Query : academicYear, semester, period
 */
router.get(
  '/:studentId/stats',
  authorize(['CAMPUS_MANAGER', 'TEACHER', 'ADMIN', 'DIRECTOR']),
  getStudentStats
);

module.exports = router;