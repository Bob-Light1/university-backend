'use strict';

/**
 * @file mentor.readonly.controller.js
 * @description Read-only endpoints scoped to the authenticated mentor's data.
 *
 *  GET /api/mentors/me/dashboard   → getDashboard
 *  GET /api/mentors/me/students    → getMyStudents
 *  GET /api/mentors/me/results     → getMyResults
 *  GET /api/mentors/me/attendance  → getMyAttendance
 *  GET /api/mentors/me/courses     → getMyCourses
 *
 * Scope contract: a mentor only ever sees data for students and classes
 * listed in their own mentor document (mentor.students[] / mentor.classes[]).
 * Campus isolation is enforced via schoolCampus from JWT.
 */

const mongoose          = require('mongoose');
const mentorRepo        = require('../mentor.repository');
const studentService    = require('../../student').service; // student module facade (§3)
const courseService     = require('../../course').service; // course module facade (§3)
// NB: the old import `const Result = require('models/result.model')` did not
// destructure { Result } — Result.find/countDocuments were undefined
// and all mentor result routes responded with 500 (latent bug fixed
// by switching to the result facade).
const resultService     = require('../../result').service; // result module facade (§3)

const {
  sendSuccess,
  sendError,
  sendNotFound,
  sendPaginated,
} = require('../../../shared/utils/response-helpers');
const { escapeRegex } = require('../../../shared/utils/validation-helpers');

// ── Helpers ───────────────────────────────────────────────────────────────────

const toOid  = (id) => new mongoose.Types.ObjectId(id);

/**
 * Loads the mentor document to get their students[] and classes[].
 * Returns null and sends 404 if not found.
 */
const loadMentor = async (req, res) => {
  const mentor = await mentorRepo.findAssignmentsFor(toOid(req.user.id), toOid(req.user.campusId));

  if (!mentor) {
    sendNotFound(res, 'Mentor');
    return null;
  }
  return mentor;
};

// ── DASHBOARD ─────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/mentors/me/dashboard
 * @access MENTOR
 */
const getDashboard = async (req, res) => {
  try {
    const mentor = await loadMentor(req, res);
    if (!mentor) return;

    const studentIds = mentor.students ?? [];
    const classIds   = mentor.classes  ?? [];
    const campusId   = toOid(req.user.campusId);

    const [
      totalStudents,
      activeStudents,
      totalResults,
      attendanceSummary,
      recentResults,
    ] = await Promise.all([
      // Total assigned students
      studentService.countStudents({ studentIds }),

      // Active students
      studentService.countStudents({ studentIds, status: 'active' }),

      // Total results published for their students
      studentIds.length
        ? resultService.countPublishedResults({ campusId, studentIds, withDeleted: true })
        : 0,

      // Attendance summary: total & present for their classes
      classIds.length
        ? studentService.summarizeAttendanceTotals({ campusId, classIds })
        : Promise.resolve([]),

      // Last 5 published results for their students
      studentIds.length
        ? resultService.getRecentResultsForStudents(studentIds, campusId)
        : Promise.resolve([]),
    ]);

    const agg = attendanceSummary[0] ?? { total: 0, present: 0 };
    const attendanceRate = agg.total > 0
      ? Math.round((agg.present / agg.total) * 100)
      : null;

    return sendSuccess(res, 200, 'Dashboard loaded.', {
      stats: {
        totalStudents,
        activeStudents,
        totalResults,
        attendanceRate,
        totalClasses: classIds.length,
      },
      recentResults,
    });

  } catch (err) {
    console.error('❌ mentor getDashboard error:', err);
    return sendError(res, 500, 'Failed to load dashboard.');
  }
};

// ── MY STUDENTS ───────────────────────────────────────────────────────────────

/**
 * @route  GET /api/mentors/me/students
 * @access MENTOR
 * @query  search, status, classId, page, limit
 */
const getMyStudents = async (req, res) => {
  try {
    const mentor = await loadMentor(req, res);
    if (!mentor) return;

    const studentIds = mentor.students ?? [];
    if (!studentIds.length) return sendPaginated(res, 200, 'No students assigned.', [], { total: 0, page: 1, limit: 20 });

    const { page = 1, limit = 20, search, status, classId } = req.query;

    // NB: the search was not escaping the regex (injection possible) — aligned
    // with the escaped version, as per bug #6 (mentor course search).
    const { docs, total } = await studentService.listStudentsForMentor({
      studentIds,
      status,
      classId,
      search: search ? escapeRegex(search.trim()) : undefined,
      page,
      limit,
    });

    return sendPaginated(res, 200, 'Students retrieved.', docs, { total, page: Number(page), limit: Number(limit) });

  } catch (err) {
    console.error('❌ mentor getMyStudents error:', err);
    return sendError(res, 500, 'Failed to retrieve students.');
  }
};

// ── MY RESULTS ────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/mentors/me/results
 * @access MENTOR
 * @query  studentId, subjectId, academicYear, semester, page, limit
 */
const getMyResults = async (req, res) => {
  try {
    const mentor = await loadMentor(req, res);
    if (!mentor) return;

    const studentIds = mentor.students ?? [];
    if (!studentIds.length) return sendPaginated(res, 200, 'No students assigned.', [], { total: 0, page: 1, limit: 20 });

    const {
      page = 1, limit = 20,
      studentId, subjectId, academicYear, semester,
    } = req.query;

    const scopedStudentId = (studentId && studentIds.map(String).includes(studentId))
      ? toOid(studentId)
      : undefined;

    const { docs, total } = await resultService.listCampusResults({
      campusId:  toOid(req.user.campusId),
      studentIds,
      studentId: scopedStudentId,
      subjectId: subjectId ? toOid(subjectId) : undefined,
      academicYear, semester,
      page, limit,
      withDeleted: true, // the old mentor filter did not exclude isDeleted
    });

    return sendPaginated(res, 200, 'Results retrieved.', docs, { total, page: Number(page), limit: Number(limit) });

  } catch (err) {
    console.error('❌ mentor getMyResults error:', err);
    return sendError(res, 500, 'Failed to retrieve results.');
  }
};

// ── MY ATTENDANCE ─────────────────────────────────────────────────────────────

/**
 * @route  GET /api/mentors/me/attendance
 * @access MENTOR
 * @query  classId, studentId, status, from, to, page, limit
 */
const getMyAttendance = async (req, res) => {
  try {
    const mentor = await loadMentor(req, res);
    if (!mentor) return;

    const classIds   = mentor.classes  ?? [];
    const studentIds = mentor.students ?? [];

    if (!classIds.length && !studentIds.length) {
      return sendPaginated(res, 200, 'No classes or students assigned.', [], { total: 0, page: 1, limit: 20 });
    }

    const {
      page = 1, limit = 20,
      classId, studentId, status, from, to,
    } = req.query;

    // Scope: either a specific class (must belong to mentor) or all their classes
    if (classId && !classIds.map(String).includes(classId)) {
      return sendError(res, 403, 'This class is not assigned to you.');
    }
    // Optionally further filter to a specific student
    if (studentId && !studentIds.map(String).includes(studentId)) {
      return sendError(res, 403, 'This student is not assigned to you.');
    }

    const { docs, total } = await studentService.listAttendanceForMentor({
      campusId:  toOid(req.user.campusId),
      classId:   classId   ? toOid(classId)   : undefined,
      classIds:  classId ? undefined : classIds,
      studentId: studentId ? toOid(studentId) : undefined,
      status,
      from,
      to,
      page,
      limit,
    });

    return sendPaginated(res, 200, 'Attendance retrieved.', docs, { total, page: Number(page), limit: Number(limit) });

  } catch (err) {
    console.error('❌ mentor getMyAttendance error:', err);
    return sendError(res, 500, 'Failed to retrieve attendance.');
  }
};

// ── MY COURSES ────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/mentors/me/courses
 * @access MENTOR
 * @query  search, page, limit
 */
const getMyCourses = async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;

    // NB: the course facade escapes the search regex (the old mentor version
    // did not — fixes a latent regex injection bug).
    const { docs, total } = await courseService.listApprovedCourses({ search, page, limit });

    return sendPaginated(res, 200, 'Courses retrieved.', docs, { total, page: Number(page), limit: Number(limit) });

  } catch (err) {
    console.error('❌ mentor getMyCourses error:', err);
    return sendError(res, 500, 'Failed to retrieve courses.');
  }
};

module.exports = {
  getDashboard,
  getMyStudents,
  getMyResults,
  getMyAttendance,
  getMyCourses,
};
