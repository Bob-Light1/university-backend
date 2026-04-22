'use strict';

/**
 * @file teacherAttendance.router.js
 * @description Express router for teacher attendance endpoints.
 *
 *  Base path : /api/attendance/teacher
 */

const express = require('express');
const router  = express.Router();

const { authenticate, authorize } = require('../middleware/auth/auth');
const { apiLimiter }              = require('../middleware/rate-limiter/rate-limiter');

const {
  initSessionAttendance,
  getSessionAttendance,
  toggleTeacherStatus,
  justifyAbsence,
  assignReplacement,
  markAsPaid,
  lockDailyAttendance,
  getMyAttendance,
  getMyStats,
  getTeacherStats,
  getCampusStats,
  getPayrollReport,
  getCampusOverview,
} = require('../controllers/teacher-controllers/teacherAttendance.controller');

// ─────────────────────────────────────────────
// MIDDLEWARE GLOBAL
// ─────────────────────────────────────────────
router.use(authenticate);
router.use(apiLimiter);

// ─────────────────────────────────────────────
// ANALYTICS ADMIN (déclarées avant /:teacherId et /:attendanceId)
// ─────────────────────────────────────────────

/**
 * GET /api/attendance/teacher/campus/overview
 * Vue d'ensemble paginée des présences enseignants sur le campus.
 * Query : from, to, teacherId?, status (true|false), isPaid, page, limit
 */
router.get(
  '/campus/overview',
  authorize(['CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  getCampusOverview
);

/**
 * GET /api/attendance/teacher/campus/stats
 * Vue agrégée des présences enseignants (totaux, taux) pour le campus.
 * Query : date?, period (day|month|year)
 */
router.get(
  '/campus/stats',
  authorize(['CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  getCampusStats
);

/**
 * GET /api/attendance/teacher/campus/payroll
 * Rapport de paie : heures délivrées par enseignant.
 * Query : month (1–12, requis), year (requis), isPaid (true|false|all)
 */
router.get(
  '/campus/payroll',
  authorize(['CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  getPayrollReport
);

// ─────────────────────────────────────────────
// ADMINISTRATIVE — lock-daily (avant /:attendanceId)
// ─────────────────────────────────────────────

/**
 * PATCH /api/attendance/teacher/lock-daily
 * Verrouille toutes les présences enseignants d'une date sur le campus.
 * Body : { date? } – défaut : aujourd'hui
 */
router.patch(
  '/lock-daily',
  authorize(['CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  lockDailyAttendance
);

// ─────────────────────────────────────────────
// SELF-SERVICE ENSEIGNANT
// ─────────────────────────────────────────────

/**
 * GET /api/attendance/teacher/me
 * Historique de présence de l'enseignant connecté.
 * Query : academicYear (requis), semester (requis), from?, to?
 */
router.get(
  '/me',
  authorize(['TEACHER']),
  getMyAttendance
);

/**
 * GET /api/attendance/teacher/me/stats
 * Statistiques de présence de l'enseignant connecté.
 * Query : academicYear (requis), semester (requis), period (all|month|week)
 */
router.get(
  '/me/stats',
  authorize(['TEACHER']),
  getMyStats
);

// ─────────────────────────────────────────────
// ROUTES AU NIVEAU DE LA SÉANCE (CAMPUS_MANAGER / ADMIN / DIRECTOR)
// Seul le Campus Manager (et ADMIN/DIRECTOR) peut enregistrer
// la présence d'un enseignant.
// ─────────────────────────────────────────────

/**
 * POST /api/attendance/teacher/sessions/:scheduleId/init
 * Crée l'enregistrement de présence enseignant pour une séance (upsert).
 * Body : { teacherId, classId, subjectId, attendanceDate,
 *           academicYear, semester, sessionStartTime?, sessionEndTime?,
 *           schoolCampus? (ADMIN/DIRECTOR uniquement) }
 */
router.post(
  '/sessions/:scheduleId/init',
  authorize(['CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  initSessionAttendance
);

/**
 * GET /api/attendance/teacher/sessions/:scheduleId
 * Enregistrement(s) de présence enseignant pour une séance.
 * Query : date?
 */
router.get(
  '/sessions/:scheduleId',
  authorize(['CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  getSessionAttendance
);

// ─────────────────────────────────────────────
// ROUTES SUR UN ENREGISTREMENT INDIVIDUEL
// ─────────────────────────────────────────────

/**
 * PATCH /api/attendance/teacher/:attendanceId/toggle
 * Marque un enseignant comme présent ou absent.
 * Body : { status: boolean }
 */
router.patch(
  '/:attendanceId/toggle',
  authorize(['CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  toggleTeacherStatus
);

/**
 * PATCH /api/attendance/teacher/:attendanceId/justify
 * Ajoute une justification pour une absence enseignant.
 * Body : { justification (string), justificationDocument? (URL) }
 */
router.patch(
  '/:attendanceId/justify',
  authorize(['CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  justifyAbsence
);

/**
 * PATCH /api/attendance/teacher/:attendanceId/replacement
 * Affecte un enseignant remplaçant pour une session manquée.
 * Body : { replacementTeacherId, replacementNotes? }
 */
router.patch(
  '/:attendanceId/replacement',
  authorize(['CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  assignReplacement
);

/**
 * PATCH /api/attendance/teacher/:attendanceId/pay
 * Marque une séance comme payée.
 * Body : { paymentRef (string) }
 */
router.patch(
  '/:attendanceId/pay',
  authorize(['CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  markAsPaid
);

// ─────────────────────────────────────────────
// STATS PAR ENSEIGNANT (après /me et /campus)
// ─────────────────────────────────────────────

/**
 * GET /api/attendance/teacher/:teacherId/stats
 * Statistiques de présence pour un enseignant spécifique.
 * Query : academicYear (requis), semester (requis), period (all|month|week)
 */
router.get(
  '/:teacherId/stats',
  authorize(['CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  getTeacherStats
);

module.exports = router;