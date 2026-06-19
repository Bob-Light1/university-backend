'use strict';

/**
 * @file teacher-schedule.router.js
 * @description Express router for teacher-facing schedule, availability,
 *              workload and roll-call endpoints.
 *
 *  Base path (registered in server.js):
 *    /api/schedules/teacher
 *
 *  Access policy:
 *  ──────────────────────────────────────
 *  • OPERATIONAL actions (roll-call open/submit, postponement review):
 *      CAMPUS_MANAGER + TEACHER only.
 *      ADMIN / DIRECTOR must not perform campus-level operational tasks.
 *
 *  • READ / REPORTING (workload, postponement list, session detail):
 *      ADMIN / DIRECTOR / CAMPUS_MANAGER — cross-campus visibility for oversight.
 */

const express = require('express');
const router  = express.Router();

const { authenticate, authorize } = require('../../shared/middleware/auth');
const { apiLimiter }              = require('../../shared/middleware/rate-limiter');

const {
  // Teacher
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
} = require('./controllers/teacher.schedule.controller');

// ─────────────────────────────────────────────
// MIDDLEWARE GLOBAL
// ─────────────────────────────────────────────
router.use(authenticate);
router.use(apiLimiter);

// ─────────────────────────────────────────────
// ANALYTICS ADMIN (before /:id)
// ─────────────────────────────────────────────

/**
 * GET /api/schedules/teacher/admin/workload
 * Global workload report for payroll.
 * Query: periodType (WEEKLY|MONTHLY), periodLabel, campusId?, department?
 */
router.get(
  '/admin/workload',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  getAllTeachersWorkload
);

/**
 * GET /api/schedules/teacher/admin/postponements
 * Lists postponement requests for the campus (filtered by status).
 * Query: status (PENDING|APPROVED|REJECTED), page, limit
 */
router.get(
  '/admin/postponements',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  getPendingPostponements
);

/**
 * GET /api/schedules/teacher/admin/:teacherId/sessions
 * All sessions of a specific teacher (admin view).
 * Query: from, to, status?, page, limit, includeAllStatuses
 */
router.get(
  '/admin/:teacherId/sessions',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  getTeacherSessionsAdmin
);

/**
 * PATCH /api/schedules/teacher/admin/postpone/:requestId/review
 * The Campus Manager approves or rejects a postponement request.
 * Body: { status: 'APPROVED' | 'REJECTED', reviewNote? }
 */
router.patch(
  '/admin/postpone/:requestId/review',
  authorize(['CAMPUS_MANAGER']),
  reviewPostponement
);

// ─────────────────────────────────────────────
// TEACHER SELF-SERVICE — CALENDAR
// ─────────────────────────────────────────────

/**
 * GET /api/schedules/teacher/me
 * Schedule of the logged-in teacher + weekly workload.
 * Query: from?, to?, sessionType?, includeAllStatuses?
 */
router.get(
  '/me',
  authorize(['TEACHER']),
  getMyTeacherCalendar
);

/**
 * GET /api/schedules/teacher/me/workload
 * Workload summary (planned vs. delivered hours).
 * Query: periodType (WEEKLY|MONTHLY), periodLabel?
 */
router.get(
  '/me/workload',
  authorize(['TEACHER']),
  getMyWorkloadSummary
);

// ─────────────────────────────────────────────
// TEACHER SELF-SERVICE — AVAILABILITY
// ─────────────────────────────────────────────

/**
 * GET /api/schedules/teacher/availability
 * Returns the availability slots of the logged-in teacher.
 */
router.get(
  '/availability',
  authorize(['TEACHER', 'CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  getMyAvailability
);

/**
 * PUT /api/schedules/teacher/availability
 * Submits or replaces all availability preferences (idempotent).
 * Body: { slots: [{ day, startHour, endHour, isAvailable, reason? }],
 *           academicYear?, semester? }
 */
router.put(
  '/availability',
  authorize(['TEACHER']),
  upsertAvailability
);

// ─────────────────────────────────────────────
// ROLL-CALL — tied to a session
// ─────────────────────────────────────────────

/**
 * PATCH /api/schedules/teacher/:id/rollcall/open
 * Opens the roll-call for a session.
 */
router.patch(
  '/:id/rollcall/open',
  authorize(['TEACHER', 'CAMPUS_MANAGER']),
  openRollCall
);

/**
 * PATCH /api/schedules/teacher/:id/rollcall/submit
 * Locks the roll-call with the attendance counts.
 * Body: { present, absent, late }
 */
router.patch(
  '/:id/rollcall/submit',
  authorize(['TEACHER', 'CAMPUS_MANAGER']),
  submitRollCall
);

/**
 * GET /api/schedules/teacher/:id/students
 * Returns the list of students for a session (roll-call interface).
 */
router.get(
  '/:id/students',
  authorize(['TEACHER', 'CAMPUS_MANAGER']),
  getStudentRoster
);

// ─────────────────────────────────────────────
// POSTPONEMENT REQUEST (teacher)
// ─────────────────────────────────────────────

/**
 * POST /api/schedules/teacher/:id/postpone
 * The teacher submits a postponement request.
 * Body: { reason (min 10 chars), proposedStart?, proposedEnd? }
 */
router.post(
  '/:id/postpone',
  authorize(['TEACHER']),
  requestPostponement
);

// ─────────────────────────────────────────────
// SINGLE READ — session (after the named routes)
// ─────────────────────────────────────────────

/**
 * GET /api/schedules/teacher/:id
 * Details of a session with room equipment.
 * A teacher can only access their own sessions;
 * admins see everything (checked in the controller).
 */
router.get(
  '/:id',
  authorize(['TEACHER', 'CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  getTeacherSessionById
);

module.exports = router;