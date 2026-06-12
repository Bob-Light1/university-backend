'use strict';

/**
 * @file staff-permissions.js
 * @description Exhaustive list of permission keys used by the Staff role.
 *
 * Each StaffRole document stores a subset of these keys in its `permissions`
 * array. The requirePermission(key) middleware checks req.user.permissions
 * (injected at login from the assigned StaffRole).
 *
 * Naming convention: <resource>.<action> for two-level access, bare noun for
 * cross-cutting concerns.
 */

const STAFF_PERMISSIONS = Object.freeze({
  // ─── Students ───────────────────────────────────────────────────────────────
  STUDENTS_READ:    'students.read',
  STUDENTS_MANAGE:  'students.manage',

  // ─── Teachers ────────────────────────────────────────────────────────────────
  TEACHERS_READ:    'teachers.read',
  TEACHERS_MANAGE:  'teachers.manage',

  // ─── Parents ─────────────────────────────────────────────────────────────────
  PARENTS_READ:     'parents.read',
  PARENTS_MANAGE:   'parents.manage',

  // ─── Finance ─────────────────────────────────────────────────────────────────
  FINANCE_READ:     'finance.read',
  FINANCE_MANAGE:   'finance.manage',

  // ─── Schedule ────────────────────────────────────────────────────────────────
  SCHEDULE_READ:    'schedule.read',
  SCHEDULE_MANAGE:  'schedule.manage',

  // ─── Attendance ──────────────────────────────────────────────────────────────
  ATTENDANCE_READ:  'attendance.read',
  ATTENDANCE_MANAGE:'attendance.manage',

  // ─── Results ─────────────────────────────────────────────────────────────────
  RESULTS_READ:     'results.read',
  RESULTS_MANAGE:   'results.manage',

  // ─── Courses ─────────────────────────────────────────────────────────────────
  COURSES_READ:     'courses.read',
  COURSES_MANAGE:   'courses.manage',

  // ─── Documents ───────────────────────────────────────────────────────────────
  DOCUMENTS_READ:   'documents.read',
  DOCUMENTS_MANAGE: 'documents.manage',

  // ─── Examinations ────────────────────────────────────────────────────────────
  EXAMINATIONS_READ:   'examinations.read',
  EXAMINATIONS_MANAGE: 'examinations.manage',

  // ─── Cross-cutting ───────────────────────────────────────────────────────────
  ANNOUNCEMENTS: 'announcements',
  MESSAGES:      'messages',
  PRINT:         'print',
});

/** Flat array of all valid permission string values — used for enum validation. */
const ALL_PERMISSIONS = Object.values(STAFF_PERMISSIONS);

module.exports = { STAFF_PERMISSIONS, ALL_PERMISSIONS };
