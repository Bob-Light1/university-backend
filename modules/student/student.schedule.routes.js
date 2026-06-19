'use strict';

/**
 * @file student-schedule.router.js
 * @description Express router for student-facing schedule endpoints.
 *
 *  Base path (registered in server.js):
 *    /api/schedules/student
 *
 *  Access policy:
 *  ──────────────────────────────────────
 *  • WRITE operations (create, update, publish, cancel, delete):
 *      CAMPUS_MANAGER only — schedule creation is an operational campus task.
 *      ADMIN / DIRECTOR have strategic oversight; they must not bypass the
 *      campus manager by writing sessions directly into a campus.
 *
 *  • READ operations (overview, reports, session detail):
 *      ADMIN / DIRECTOR / CAMPUS_MANAGER — cross-campus visibility for reporting.
 *
 *  • Campus isolation on reads: enforced in the controller via buildCampusFilter().
 *    ADMIN/DIRECTOR receive an unrestricted filter; CAMPUS_MANAGER is locked to
 *    their own campusId.
 */

const express = require('express');
const router  = express.Router();

const { authenticate, authorize } = require('../../shared/middleware/auth');
const { apiLimiter }              = require('../../shared/middleware/rate-limiter');

const {
  // Student
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
} = require('./controllers/student.schedule.controller');

// ─────────────────────────────────────────────
// GLOBAL MIDDLEWARE
// All schedule routes require authentication.
// ─────────────────────────────────────────────
router.use(authenticate);
router.use(apiLimiter);

// ─────────────────────────────────────────────
// ADMIN ANALYTICS (declared before /:id)
// ─────────────────────────────────────────────

/**
 * GET /api/schedules/student/admin/overview
 * "Control tower" overview — multidimensional filtering.
 * Query: from, to, status, roomCode, teacherId, classId, page, limit
 */
router.get(
  '/admin/overview',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  getCampusOverview
);

/**
 * GET /api/schedules/student/admin/room-occupancy
 * Room occupancy report for a period.
 * Query: from, to, campusId (ADMIN/DIRECTOR only)
 */
router.get(
  '/admin/room-occupancy',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  getRoomOccupancyReport
);

// ─────────────────────────────────────────────
// STUDENT SELF-SERVICE
// ─────────────────────────────────────────────

/**
 * GET /api/schedules/student/me
 * Personal timetable of the authenticated student.
 * Query: from?, to?, sessionType?
 */
router.get(
  '/me',
  authorize(['STUDENT']),
  getMyCalendar
);

/**
 * GET /api/schedules/student/export/ics
 * ICS export compatible with Google Calendar / Apple / Outlook.
 * Query: from?, to?, tzid? (IANA timezone, default UTC)
 */
router.get(
  '/export/ics',
  authorize(['STUDENT']),
  exportCalendarICS
);

// ─────────────────────────────────────────────
// SESSION MANAGEMENT (ADMIN / CAMPUS_MANAGER)
// ─────────────────────────────────────────────

/**
 * POST /api/schedules/student/admin/sessions
 * Creates a new session (DRAFT status).
 * Body: { subject, sessionType, startTime, endTime, room,
 *           classIds, teacher, recurrence?, schoolCampus,
 *           isVirtual?, virtualMeeting?, topic, academicYear, semester }
 */
router.post(
  '/admin/sessions',
  authorize(['CAMPUS_MANAGER']),
  createSession
);

/**
 * PUT /api/schedules/student/admin/sessions/:id
 * Updates an existing session. Re-runs conflict detection.
 * Body: partial session fields
 */
router.put(
  '/admin/sessions/:id',
  authorize(['CAMPUS_MANAGER']),
  updateSession
);

/**
 * PATCH /api/schedules/student/admin/sessions/:id/publish
 * Moves a session DRAFT → PUBLISHED and sends notifications.
 */
router.patch(
  '/admin/sessions/:id/publish',
  authorize(['CAMPUS_MANAGER']),
  publishSession
);

/**
 * PATCH /api/schedules/student/admin/sessions/:id/cancel
 * Cancels a session and notifies the relevant parties.
 * Body: { reason? }
 */
router.patch(
  '/admin/sessions/:id/cancel',
  authorize(['CAMPUS_MANAGER']),
  cancelSession
);

/**
 * DELETE /api/schedules/student/admin/sessions/:id
 * Soft-delete of a session (isDeleted = true).
 */
router.delete(
  '/admin/sessions/:id',
  authorize(['CAMPUS_MANAGER']),
  softDeleteSession
);

// ─────────────────────────────────────────────
// SHARED READ ROUTES (after the named routes)
// ─────────────────────────────────────────────

/**
 * GET /api/schedules/student/:id/attendance
 * Attendance summary for a specific session.
 * Accessible by: STUDENT (own session), TEACHER (own sessions), CAMPUS_MANAGER, ADMIN, DIRECTOR
 */
router.get(
  '/:id/attendance',
  authorize(['STUDENT', 'TEACHER', 'CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  getAttendanceForSession
);

/**
 * GET /api/schedules/student/:id
 * Details of a published session.
 */
router.get(
  '/:id',
  authorize(['STUDENT', 'TEACHER', 'CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  getSessionById
);

module.exports = router;