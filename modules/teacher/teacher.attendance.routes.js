'use strict';

/**
 * @file teacher-attendance.router.js
 * @description Express router for teacher attendance endpoints.
 *
 *  Base path : /api/attendance/teacher
 */

const express = require('express');
const router  = express.Router();

const { authenticate, authorize } = require('../../shared/middleware/auth');
const { apiLimiter }              = require('../../shared/middleware/rate-limiter');

const {
  initSessionAttendance,
  getSessionAttendance,
  getPendingSessions,
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
} = require('./controllers/teacher.attendance.controller');

// ─────────────────────────────────────────────
// MIDDLEWARE GLOBAL
// ─────────────────────────────────────────────
router.use(authenticate);
router.use(apiLimiter);

// ─────────────────────────────────────────────
// ANALYTICS ADMIN (declared before /:teacherId and /:attendanceId)
// ─────────────────────────────────────────────

/**
 * GET /api/attendance/teacher/campus/overview
 * Paginated overview of teacher attendance on the campus.
 * Query: from, to, teacherId?, status (true|false), isPaid, page, limit
 */
router.get(
  '/campus/overview',
  authorize(['CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  getCampusOverview
);

/**
 * GET /api/attendance/teacher/campus/stats
 * Aggregated view of teacher attendance (totals, rates) for the campus.
 * Query: date?, period (day|month|year)
 */
router.get(
  '/campus/stats',
  authorize(['CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  getCampusStats
);

/**
 * GET /api/attendance/teacher/campus/payroll
 * Payroll report: hours delivered per teacher.
 * Query: month (1–12, required), year (required), isPaid (true|false|all)
 */
router.get(
  '/campus/payroll',
  authorize(['CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  getPayrollReport
);

// ─────────────────────────────────────────────
// ADMINISTRATIVE — lock-daily (before /:attendanceId)
// ─────────────────────────────────────────────

/**
 * PATCH /api/attendance/teacher/lock-daily
 * Locks all teacher attendance for a given date on the campus.
 * Body: { date? } – default: today
 * Restricted to CAMPUS_MANAGER only.
 */
router.patch(
  '/lock-daily',
  authorize(['CAMPUS_MANAGER']),
  lockDailyAttendance
);

// ─────────────────────────────────────────────
// TEACHER SELF-SERVICE
// ─────────────────────────────────────────────

/**
 * GET /api/attendance/teacher/me
 * Attendance history of the logged-in teacher.
 * Query: academicYear (required), semester (required), from?, to?
 */
router.get(
  '/me',
  authorize(['TEACHER']),
  getMyAttendance
);

/**
 * GET /api/attendance/teacher/me/stats
 * Attendance statistics of the logged-in teacher.
 * Query: academicYear (required), semester (required), period (all|month|week)
 */
router.get(
  '/me/stats',
  authorize(['TEACHER']),
  getMyStats
);

// ─────────────────────────────────────────────
// SESSION-LEVEL ROUTES
// Only the CAMPUS_MANAGER can record a teacher's attendance.
// ─────────────────────────────────────────────

/**
 * GET /api/attendance/teacher/sessions/pending
 * Sessions without an attendance record for a teacher on a given date.
 * Query: teacherId (required), date (required, YYYY-MM-DD)
 * Must be declared BEFORE /sessions/:scheduleId to avoid shadowing.
 */
router.get(
  '/sessions/pending',
  authorize(['CAMPUS_MANAGER']),
  getPendingSessions
);

/**
 * POST /api/attendance/teacher/sessions/:scheduleId/init
 * Creates or updates the teacher attendance record for a session.
 * Body: { teacherId, classId, subjectId, attendanceDate,
 *           academicYear, semester, sessionStartTime?, sessionEndTime?,
 *           status?, isLate?, lateMinutes?, remarks? }
 * Restricted to CAMPUS_MANAGER only.
 */
router.post(
  '/sessions/:scheduleId/init',
  authorize(['CAMPUS_MANAGER']),
  initSessionAttendance
);

/**
 * GET /api/attendance/teacher/sessions/:scheduleId
 * Teacher attendance record(s) for a session.
 * Query: date?
 */
router.get(
  '/sessions/:scheduleId',
  authorize(['CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  getSessionAttendance
);

// ─────────────────────────────────────────────
// ROUTES ON AN INDIVIDUAL RECORD
// ─────────────────────────────────────────────

/**
 * PATCH /api/attendance/teacher/:attendanceId/toggle
 * Marks a teacher as present or absent.
 * Body: { status: boolean }
 * Restricted to CAMPUS_MANAGER only.
 */
router.patch(
  '/:attendanceId/toggle',
  authorize(['CAMPUS_MANAGER']),
  toggleTeacherStatus
);

/**
 * PATCH /api/attendance/teacher/:attendanceId/justify
 * Adds a justification for a teacher absence.
 * Body: { justification (string), justificationDocument? (URL) }
 * Restricted to CAMPUS_MANAGER only.
 */
router.patch(
  '/:attendanceId/justify',
  authorize(['CAMPUS_MANAGER']),
  justifyAbsence
);

/**
 * PATCH /api/attendance/teacher/:attendanceId/replacement
 * Assigns a replacement teacher for a missed session.
 * Body: { replacementTeacherId, replacementNotes? }
 * Restricted to CAMPUS_MANAGER only.
 */
router.patch(
  '/:attendanceId/replacement',
  authorize(['CAMPUS_MANAGER']),
  assignReplacement
);

/**
 * PATCH /api/attendance/teacher/:attendanceId/pay
 * Marks a session as paid.
 * Body: { paymentRef (string) }
 * Accessible to the 3 management roles (payment = financial validation).
 */
router.patch(
  '/:attendanceId/pay',
  authorize(['CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  markAsPaid
);

// ─────────────────────────────────────────────
// STATS PER TEACHER (after /me and /campus)
// ─────────────────────────────────────────────

/**
 * GET /api/attendance/teacher/:teacherId/stats
 * Attendance statistics for a specific teacher.
 * Query: academicYear (required), semester (required), period (all|month|week)
 */
router.get(
  '/:teacherId/stats',
  authorize(['CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR']),
  getTeacherStats
);

module.exports = router;