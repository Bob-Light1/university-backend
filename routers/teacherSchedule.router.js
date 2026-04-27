'use strict';

/**
 * @file teacherSchedule.router.js
 * @description Express router for teacher-facing schedule, availability,
 *              workload and roll-call endpoints.
 *
 *  Base path (registered in server.js):
 *    /api/schedules/teacher
 *
 *  Alignements avec le backend foruni :
 *  ──────────────────────────────────────
 *  • Middleware : authenticate + authorize() depuis '../middleware/auth/auth'
 *  • Rôles : 'ADMIN' | 'DIRECTOR' | 'CAMPUS_MANAGER' | 'TEACHER'
 *  • DIRECTOR = même droits qu'ADMIN
 *  • Campus isolation gérée dans les controllers via req.user.campusId
 *  • apiLimiter depuis '../middleware/rate-limiter/rate-limiter'
 */

const express = require('express');
const router  = express.Router();

const { authenticate, authorize } = require('../middleware/auth/auth');
const { apiLimiter }              = require('../middleware/rate-limiter/rate-limiter');

const {
  // Enseignant
  getMyTeacherCalendar,
  getTeacherSessionById,
  openRollCall,
  submitRollCall,
  requestPostponement,
  upsertAvailability,
  getMyAvailability,
  getMyWorkloadSummary,
  getStudentRoster,
  // Admin / Campus Manager
  getTeacherSessionsAdmin,
  reviewPostponement,
  getAllTeachersWorkload,
  getPendingPostponements,
} = require('../controllers/teacher-controllers/teacherSchedule.controller');

// ─────────────────────────────────────────────
// MIDDLEWARE GLOBAL
// ─────────────────────────────────────────────
router.use(authenticate);
router.use(apiLimiter);

// ─────────────────────────────────────────────
// ANALYTICS ADMIN (avant /:id)
// ─────────────────────────────────────────────

/**
 * GET /api/schedules/teacher/admin/workload
 * Rapport de charge horaire global pour la paie.
 * Query : periodType (WEEKLY|MONTHLY), periodLabel, campusId?, department?
 */
router.get(
  '/admin/workload',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  getAllTeachersWorkload
);

/**
 * GET /api/schedules/teacher/admin/postponements
 * Liste les demandes de report pour le campus (filtrées par statut).
 * Query : status (PENDING|APPROVED|REJECTED), page, limit
 */
router.get(
  '/admin/postponements',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  getPendingPostponements
);

/**
 * GET /api/schedules/teacher/admin/:teacherId/sessions
 * Toutes les séances d'un enseignant spécifique (vue admin).
 * Query : from, to, status?, page, limit, includeAllStatuses
 */
router.get(
  '/admin/:teacherId/sessions',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  getTeacherSessionsAdmin
);

/**
 * PATCH /api/schedules/teacher/admin/postpone/:requestId/review
 * Le Campus Manager approuve ou rejette une demande de report.
 * Body : { status: 'APPROVED' | 'REJECTED', reviewNote? }
 */
router.patch(
  '/admin/postpone/:requestId/review',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  reviewPostponement
);

// ─────────────────────────────────────────────
// SELF-SERVICE ENSEIGNANT — CALENDRIER
// ─────────────────────────────────────────────

/**
 * GET /api/schedules/teacher/me
 * Emploi du temps de l'enseignant connecté + charge hebdomadaire.
 * Query : from?, to?, sessionType?, includeAllStatuses?
 */
router.get(
  '/me',
  authorize(['TEACHER']),
  getMyTeacherCalendar
);

/**
 * GET /api/schedules/teacher/me/workload
 * Résumé de charge horaire (heures planifiées vs délivrées).
 * Query : periodType (WEEKLY|MONTHLY), periodLabel?
 */
router.get(
  '/me/workload',
  authorize(['TEACHER']),
  getMyWorkloadSummary
);

// ─────────────────────────────────────────────
// SELF-SERVICE ENSEIGNANT — DISPONIBILITÉS
// ─────────────────────────────────────────────

/**
 * GET /api/schedules/teacher/availability
 * Retourne les créneaux de disponibilité de l'enseignant connecté.
 */
router.get(
  '/availability',
  authorize(['TEACHER', 'CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  getMyAvailability
);

/**
 * PUT /api/schedules/teacher/availability
 * Soumet ou remplace toutes les préférences de disponibilité (idempotent).
 * Body : { slots: [{ day, startHour, endHour, isAvailable, reason? }],
 *           academicYear?, semester? }
 */
router.put(
  '/availability',
  authorize(['TEACHER']),
  upsertAvailability
);

// ─────────────────────────────────────────────
// APPEL (roll-call) — lié à une séance
// ─────────────────────────────────────────────

/**
 * PATCH /api/schedules/teacher/:id/rollcall/open
 * Ouvre l'appel pour une séance.
 */
router.patch(
  '/:id/rollcall/open',
  authorize(['TEACHER', 'CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  openRollCall
);

/**
 * PATCH /api/schedules/teacher/:id/rollcall/submit
 * Verrouille l'appel avec les comptages de présence.
 * Body : { present, absent, late }
 */
router.patch(
  '/:id/rollcall/submit',
  authorize(['TEACHER', 'CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  submitRollCall
);

/**
 * GET /api/schedules/teacher/:id/students
 * Retourne la liste des étudiants pour une séance (interface d'appel).
 */
router.get(
  '/:id/students',
  authorize(['TEACHER', 'CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  getStudentRoster
);

// ─────────────────────────────────────────────
// DEMANDE DE REPORT (enseignant)
// ─────────────────────────────────────────────

/**
 * POST /api/schedules/teacher/:id/postpone
 * L'enseignant soumet une demande de report.
 * Body : { reason (min 10 chars), proposedStart?, proposedEnd? }
 */
router.post(
  '/:id/postpone',
  authorize(['TEACHER']),
  requestPostponement
);

// ─────────────────────────────────────────────
// LECTURE UNIQUE — séance (après les routes nommées)
// ─────────────────────────────────────────────

/**
 * GET /api/schedules/teacher/:id
 * Détails d'une séance avec équipement salle.
 * Un enseignant ne peut accéder qu'à ses propres séances ;
 * les admins voient tout (contrôle dans le controller).
 */
router.get(
  '/:id',
  authorize(['TEACHER', 'CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  getTeacherSessionById
);

module.exports = router;