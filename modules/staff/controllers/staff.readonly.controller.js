'use strict';

/**
 * @file staff.readonly.controller.js
 * @description Campus-scoped read-only endpoints for authenticated Staff members.
 *
 *  GET /api/staff/me/dashboard   → getDashboard          (STAFF)
 *  GET /api/staff/me/students    → getMyStudents         (STAFF + students.read)
 *  GET /api/staff/me/attendance  → getMyAttendance       (STAFF + attendance.read)
 *  GET /api/staff/me/results     → getMyResults          (STAFF + results.read)
 *  GET /api/staff/me/courses     → getMyCourses          (STAFF + courses.read)
 *
 * Campus scope is enforced via the JWT campusId — no param needed.
 */

const mongoose          = require('mongoose');
const studentService    = require('../../student').service;
const teacherService    = require('../../teacher').service;
const documentService   = require('../../document').service;
const examService       = require('../../exam').service;
const courseService     = require('../../course').service;
const resultService     = require('../../result').service;

const {
  sendSuccess,
  sendError,
  sendPaginated,
} = require('../../../shared/utils/response-helpers');
const { escapeRegex } = require('../../../shared/utils/validation-helpers');

const toOid = (id) => new mongoose.Types.ObjectId(id);

// ── DASHBOARD ─────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/staff/me/dashboard
 * @access STAFF
 */
const getDashboard = async (req, res) => {
  try {
    const campusId = toOid(req.user.campusId);
    const perms    = req.user.permissions ?? [];
    const stats    = {};

    const queries = [];

    if (perms.includes('students.read') || perms.includes('students.manage')) {
      queries.push(
        studentService.countStudents({ campusId })
          .then((n) => { stats.totalStudents = n; }),
        studentService.countStudents({ campusId, status: 'active' })
          .then((n) => { stats.activeStudents = n; })
      );
    }

    if (perms.includes('attendance.read') || perms.includes('attendance.manage')) {
      queries.push(
        studentService.summarizeAttendanceTotals({ campusId }).then(([r]) => {
          stats.attendanceTotal = r?.total ?? 0;
          stats.attendanceRate  = r?.total > 0
            ? Math.round((r.present / r.total) * 100)
            : null;
        })
      );
    }

    if (perms.includes('results.read') || perms.includes('results.manage')) {
      queries.push(
        resultService.countPublishedResults({ campusId })
          .then((n) => { stats.publishedResults = n; })
      );
    }

    if (perms.includes('teachers.read') || perms.includes('teachers.manage')) {
      queries.push(
        teacherService.countActiveTeachers(campusId)
          .then((n) => { stats.totalTeachers = n; })
      );
    }

    await Promise.all(queries);

    return sendSuccess(res, 200, 'Dashboard loaded.', {
      stats,
      permissions: perms,
    });

  } catch (err) {
    console.error('❌ staff getDashboard error:', err);
    return sendError(res, 500, 'Failed to load dashboard.');
  }
};

// ── STUDENTS ──────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/staff/me/students
 * @access STAFF + students.read
 * @query  search, status, page, limit
 */
const getMyStudents = async (req, res) => {
  try {
    const campusId = toOid(req.user.campusId);
    const { page = 1, limit = 20, search, status } = req.query;

    const { docs, total } = await studentService.listStudentsForStaff({
      campusId,
      status,
      search: search ? escapeRegex(search.trim()) : undefined,
      page,
      limit,
    });

    return sendPaginated(res, 200, 'Students retrieved.', docs, { total, page: Number(page), limit: Number(limit) });

  } catch (err) {
    console.error('❌ staff getMyStudents error:', err);
    return sendError(res, 500, 'Failed to retrieve students.');
  }
};

// ── ATTENDANCE ────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/staff/me/attendance
 * @access STAFF + attendance.read
 * @query  classId, studentId, status, from, to, page, limit
 */
const getMyAttendance = async (req, res) => {
  try {
    const campusId = toOid(req.user.campusId);
    const { page = 1, limit = 20, status, from, to, classId, studentId } = req.query;

    const { docs, total } = await studentService.listAttendanceForStaff({
      campusId,
      status,
      classId:   classId   ? toOid(classId)   : undefined,
      studentId: studentId ? toOid(studentId) : undefined,
      from,
      to,
      page,
      limit,
    });

    return sendPaginated(res, 200, 'Attendance retrieved.', docs, { total, page: Number(page), limit: Number(limit) });

  } catch (err) {
    console.error('❌ staff getMyAttendance error:', err);
    return sendError(res, 500, 'Failed to retrieve attendance.');
  }
};

// ── RESULTS ───────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/staff/me/results
 * @access STAFF + results.read
 * @query  studentId, subjectId, classId, academicYear, semester, evaluationType, examPeriod, page, limit
 */
const getMyResults = async (req, res) => {
  try {
    const campusId = toOid(req.user.campusId);
    const {
      page = 1, limit = 20,
      studentId, subjectId, classId,
      academicYear, semester,
      evaluationType, examPeriod,
    } = req.query;

    const { docs, total } = await resultService.listCampusResults({
      campusId,
      studentId: studentId ? toOid(studentId) : undefined,
      subjectId: subjectId ? toOid(subjectId) : undefined,
      classId:   classId   ? toOid(classId)   : undefined,
      academicYear, semester, evaluationType, examPeriod,
      page, limit,
    });

    return sendPaginated(res, 200, 'Results retrieved.', docs, { total, page: Number(page), limit: Number(limit) });

  } catch (err) {
    console.error('❌ staff getMyResults error:', err);
    return sendError(res, 500, 'Failed to retrieve results.');
  }
};

// ── COURSES ───────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/staff/me/courses
 * @access STAFF + courses.read
 * @query  search, page, limit
 */
const getMyCourses = async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;

    const { docs, total } = await courseService.listApprovedCourses({ search, page, limit });

    return sendPaginated(res, 200, 'Courses retrieved.', docs, { total, page: Number(page), limit: Number(limit) });

  } catch (err) {
    console.error('❌ staff getMyCourses error:', err);
    return sendError(res, 500, 'Failed to retrieve courses.');
  }
};

// ── TEACHERS ──────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/staff/me/teachers
 * @access STAFF + teachers.read
 * @query  search, status, page, limit
 */
const getMyTeachers = async (req, res) => {
  try {
    const campusId = toOid(req.user.campusId);
    const { page = 1, limit = 20, search, status } = req.query;

    const { docs, total } = await teacherService.listTeachersForStaff({
      campusId,
      status,
      search: search ? escapeRegex(search.trim()) : undefined,
      page,
      limit,
    });

    return sendPaginated(res, 200, 'Teachers retrieved.', docs, { total, page: Number(page), limit: Number(limit) });

  } catch (err) {
    console.error('❌ staff getMyTeachers error:', err);
    return sendError(res, 500, 'Failed to retrieve teachers.');
  }
};

// ── SCHEDULE ──────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/staff/me/schedule
 * @access STAFF + schedule.read
 * @query  from, to, status, page, limit
 */
const getMySchedule = async (req, res) => {
  try {
    const campusId = toOid(req.user.campusId);
    const { page = 1, limit = 20, from, to, status } = req.query;

    const { docs, total } = await teacherService.listTeacherSchedulesForStaff({
      campusId,
      status,
      from,
      to,
      page,
      limit,
    });

    return sendPaginated(res, 200, 'Schedule retrieved.', docs, { total, page: Number(page), limit: Number(limit) });

  } catch (err) {
    console.error('❌ staff getMySchedule error:', err);
    return sendError(res, 500, 'Failed to retrieve schedule.');
  }
};

// ── DOCUMENTS ─────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/staff/me/documents
 * @access STAFF + documents.read
 * @query  search, type, category, page, limit
 */
const getMyDocuments = async (req, res) => {
  try {
    const campusId = toOid(req.user.campusId);
    const { page = 1, limit = 20, search, type, category } = req.query;

    const { docs, total } = await documentService.listPublishedForCampus({
      campusId, page, limit, search, type, category,
    });

    return sendPaginated(res, 200, 'Documents retrieved.', docs, { total, page: Number(page), limit: Number(limit) });

  } catch (err) {
    console.error('❌ staff getMyDocuments error:', err);
    return sendError(res, 500, 'Failed to retrieve documents.');
  }
};

// ── EXAMINATIONS ──────────────────────────────────────────────────────────────

/**
 * @route  GET /api/staff/me/examinations
 * @access STAFF + examinations.read
 * @query  academicYear, semester, status, page, limit
 */
const getMyExaminations = async (req, res) => {
  try {
    const campusId = toOid(req.user.campusId);
    const { page = 1, limit = 20, academicYear, semester, status } = req.query;

    const { docs, total } = await examService.listCampusExaminations({
      campusId, page, limit, academicYear, semester, status,
    });

    return sendPaginated(res, 200, 'Examinations retrieved.', docs, { total, page: Number(page), limit: Number(limit) });

  } catch (err) {
    console.error('❌ staff getMyExaminations error:', err);
    return sendError(res, 500, 'Failed to retrieve examinations.');
  }
};

module.exports = {
  getDashboard,
  getMyStudents,
  getMyAttendance,
  getMyResults,
  getMyCourses,
  getMyTeachers,
  getMySchedule,
  getMyDocuments,
  getMyExaminations,
};
