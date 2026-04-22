'use strict';

/**
 * @file studentSchedule.router.js
 * @description Express router for student-facing schedule endpoints.
 *
 *  Base path (registered in server.js):
 *    /api/schedules/student
 *
 *  Alignements avec le backend foruni :
 *  ──────────────────────────────────────
 *  • Middleware : authenticate + authorize() depuis '../middleware/auth/auth'
 *    (PAS protect() ni campusIsolation — ces abstractions n'existent pas dans foruni)
 *  • Rôles disponibles : 'ADMIN' | 'DIRECTOR' | 'CAMPUS_MANAGER' | 'TEACHER' | 'STUDENT'
 *  • DIRECTOR a les mêmes droits qu'ADMIN dans foruni
 *  • Campus isolation : gérée dans chaque controller via req.user.campusId
 *  • apiLimiter importé depuis '../middleware/rate-limiter/rate-limiter'
 */

const express = require('express');
const router  = express.Router();

const { authenticate, authorize } = require('../middleware/auth/auth');
const { apiLimiter }              = require('../middleware/rate-limiter/rate-limiter');

const {
  // Étudiant
  getMyCalendar,
  getSessionById,
  exportCalendarICS,
  getAttendanceForSession,
  // Admin / Campus Manager
  createSession,
  updateSession,
  publishSession,
  cancelSession,
  softDeleteSession,
  getCampusOverview,
  getRoomOccupancyReport,
} = require('../controllers/student-controllers/studentSchedule.controller');

// ─────────────────────────────────────────────
// MIDDLEWARE GLOBAL
// Toutes les routes du schedule requièrent une authentification.
// ─────────────────────────────────────────────
router.use(authenticate);
router.use(apiLimiter);

// ─────────────────────────────────────────────
// ANALYTICS ADMIN (déclarées avant /:id)
// ─────────────────────────────────────────────

/**
 * GET /api/schedules/student/admin/overview
 * Vue d'ensemble "tour de contrôle" — filtrages multidimensionnels.
 * Query : from, to, status, roomCode, teacherId, classId, page, limit
 */
router.get(
  '/admin/overview',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  getCampusOverview
);

/**
 * GET /api/schedules/student/admin/room-occupancy
 * Rapport d'occupation des salles pour une période.
 * Query : from, to, campusId (ADMIN/DIRECTOR seulement)
 */
router.get(
  '/admin/room-occupancy',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  getRoomOccupancyReport
);

// ─────────────────────────────────────────────
// SELF-SERVICE ÉTUDIANT
// ─────────────────────────────────────────────

/**
 * GET /api/schedules/student/me
 * Emploi du temps personnel de l'étudiant connecté.
 * Query : from?, to?, sessionType?
 */
router.get(
  '/me',
  authorize(['STUDENT']),
  getMyCalendar
);

/**
 * GET /api/schedules/student/export/ics
 * Export ICS compatible Google Calendar / Apple / Outlook.
 * Query : from?, to?, tzid? (IANA timezone, défaut UTC)
 */
router.get(
  '/export/ics',
  authorize(['STUDENT']),
  exportCalendarICS
);

// ─────────────────────────────────────────────
// GESTION DES SESSIONS (ADMIN / CAMPUS_MANAGER)
// ─────────────────────────────────────────────

/**
 * POST /api/schedules/student/admin/sessions
 * Crée une nouvelle séance (statut DRAFT).
 * Body : { subject, sessionType, startTime, endTime, room,
 *           classIds, teacher, recurrence?, schoolCampus,
 *           isVirtual?, virtualMeeting?, topic, academicYear, semester }
 */
router.post(
  '/admin/sessions',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  createSession
);

/**
 * PUT /api/schedules/student/admin/sessions/:id
 * Met à jour une séance existante. Relance la détection de conflits.
 * Body : champs partiels de la session
 */
router.put(
  '/admin/sessions/:id',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  updateSession
);

/**
 * PATCH /api/schedules/student/admin/sessions/:id/publish
 * Passe une séance DRAFT → PUBLISHED et envoie les notifications.
 */
router.patch(
  '/admin/sessions/:id/publish',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  publishSession
);

/**
 * PATCH /api/schedules/student/admin/sessions/:id/cancel
 * Annule une séance et notifie les parties concernées.
 * Body : { reason? }
 */
router.patch(
  '/admin/sessions/:id/cancel',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  cancelSession
);

/**
 * DELETE /api/schedules/student/admin/sessions/:id
 * Soft-delete d'une séance (isDeleted = true).
 */
router.delete(
  '/admin/sessions/:id',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  softDeleteSession
);

// ─────────────────────────────────────────────
// ROUTES DE LECTURE PARTAGÉES (après les routes nommées)
// ─────────────────────────────────────────────

/**
 * GET /api/schedules/student/:id/attendance
 * Résumé de présence pour une séance spécifique.
 * Accessible par : STUDENT (sa séance), TEACHER (ses séances), CAMPUS_MANAGER, ADMIN, DIRECTOR
 */
router.get(
  '/:id/attendance',
  authorize(['STUDENT', 'TEACHER', 'CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  getAttendanceForSession
);

/**
 * GET /api/schedules/student/:id
 * Détails d'une séance publiée.
 */
router.get(
  '/:id',
  authorize(['STUDENT', 'TEACHER', 'CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  getSessionById
);

module.exports = router;