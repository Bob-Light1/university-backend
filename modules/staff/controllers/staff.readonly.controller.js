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
// Cross-domaine : anciens chemins tant que ces domaines ne sont pas des modules (§6)
const Student           = require('../../../models/student-models/student.model');
const { Result }        = require('../../../models/result.model');
const StudentAttendance = require('../../../models/student-models/student.attend.model');
const Course            = require('../../../models/course.model');
const Teacher           = require('../../../models/teacher-models/teacher.model');
const TeacherSchedule   = require('../../../models/teacher-models/teacher.schedule.model');
const documentService   = require('../../document').service;
const examService       = require('../../exam').service;

const {
  sendSuccess,
  sendError,
  sendPaginated,
} = require('../../../shared/utils/response-helpers');
const { escapeRegex } = require('../../../utils/validation-helpers');

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
        Student.countDocuments({ schoolCampus: campusId })
          .then((n) => { stats.totalStudents = n; }),
        Student.countDocuments({ schoolCampus: campusId, status: 'active' })
          .then((n) => { stats.activeStudents = n; })
      );
    }

    if (perms.includes('attendance.read') || perms.includes('attendance.manage')) {
      queries.push(
        StudentAttendance.aggregate([
          { $match: { schoolCampus: campusId } },
          {
            $group: {
              _id:     null,
              total:   { $sum: 1 },
              present: { $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } },
            },
          },
        ]).then(([r]) => {
          stats.attendanceTotal = r?.total ?? 0;
          stats.attendanceRate  = r?.total > 0
            ? Math.round((r.present / r.total) * 100)
            : null;
        })
      );
    }

    if (perms.includes('results.read') || perms.includes('results.manage')) {
      queries.push(
        Result.countDocuments({ schoolCampus: campusId, status: 'PUBLISHED', isDeleted: false })
          .then((n) => { stats.publishedResults = n; })
      );
    }

    if (perms.includes('teachers.read') || perms.includes('teachers.manage')) {
      queries.push(
        Teacher.countDocuments({ schoolCampus: campusId, status: { $ne: 'archived' } })
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

    const filter = { schoolCampus: campusId };
    if (status) filter.status = status;
    if (search) {
      const rx = new RegExp(escapeRegex(search.trim()), 'i');
      filter.$or = [{ firstName: rx }, { lastName: rx }, { email: rx }, { matricule: rx }];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [docs, total] = await Promise.all([
      Student.find(filter)
        .select('-password -__v')
        .populate('studentClass', 'className')
        .sort({ lastName: 1, firstName: 1 })
        .skip(skip).limit(Number(limit)).lean({ virtuals: true }),
      Student.countDocuments(filter),
    ]);

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

    const filter = { schoolCampus: campusId };
    if (status) {
      if      (status === 'present')  { filter.status = true;  filter.isLate = false; }
      else if (status === 'late')     { filter.isLate = true; }
      else if (status === 'excused')  { filter.status = false; filter.isJustified = true; }
      else if (status === 'absent')   { filter.status = false; filter.isJustified = { $ne: true }; }
    }
    if (classId)   filter.class   = toOid(classId);
    if (studentId) filter.student = toOid(studentId);
    if (from || to) {
      filter.attendanceDate = {};
      if (from) filter.attendanceDate.$gte = new Date(from);
      if (to)   filter.attendanceDate.$lte = new Date(to);
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [docs, total] = await Promise.all([
      StudentAttendance.find(filter)
        .select('-__v')
        .populate('student', 'firstName lastName matricule profileImage')
        .populate('class', 'className')
        .sort({ attendanceDate: -1 })
        .skip(skip).limit(Number(limit)).lean(),
      StudentAttendance.countDocuments(filter),
    ]);

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

    const filter = { schoolCampus: campusId, status: 'PUBLISHED', isDeleted: false };
    if (studentId)      filter.student        = toOid(studentId);
    if (subjectId)      filter.subject        = toOid(subjectId);
    if (classId)        filter.class          = toOid(classId);
    if (academicYear)   filter.academicYear   = academicYear;
    if (semester)       filter.semester       = semester;
    if (evaluationType) filter.evaluationType = evaluationType;
    if (examPeriod)     filter.examPeriod     = examPeriod;

    const skip = (Number(page) - 1) * Number(limit);
    const [docs, total] = await Promise.all([
      Result.find(filter)
        .select('-__v')
        .populate('student', 'firstName lastName matricule profileImage')
        .populate('subject', 'subject_name')
        .populate('class',   'className')
        .sort({ createdAt: -1 })
        .skip(skip).limit(Number(limit)).lean(),
      Result.countDocuments(filter),
    ]);

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

    const filter = {
      approvalStatus:  'APPROVED',
      isLatestVersion: true,
      status:          { $ne: 'archived' },
    };
    if (search) {
      const rx = new RegExp(escapeRegex(search.trim()), 'i');
      filter.$or = [{ title: rx }, { courseCode: rx }, { description: rx }];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [docs, total] = await Promise.all([
      Course.find(filter)
        .select('-__v')
        .populate('subject',   'subject_name')
        .populate('createdBy', 'firstName lastName')
        .sort({ title: 1 })
        .skip(skip).limit(Number(limit)).lean(),
      Course.countDocuments(filter),
    ]);

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

    const filter = { schoolCampus: campusId };
    if (status) {
      filter.status = status;
    } else {
      filter.status = { $ne: 'archived' };
    }
    if (search) {
      const rx = new RegExp(escapeRegex(search.trim()), 'i');
      filter.$or = [{ firstName: rx }, { lastName: rx }, { email: rx }, { username: rx }];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [docs, total] = await Promise.all([
      Teacher.find(filter)
        .select('-password -__v -contractSnapshot')
        .populate('classes',  'className')
        .populate('subjects', 'subject_name subject_code')
        .sort({ lastName: 1, firstName: 1 })
        .skip(skip).limit(Number(limit)).lean({ virtuals: true }),
      Teacher.countDocuments(filter),
    ]);

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

    const filter = { schoolCampus: campusId };
    if (status) {
      filter.status = status;
    } else {
      filter.status = { $in: ['PUBLISHED', 'DRAFT'] };
    }
    if (from || to) {
      filter.startTime = {};
      if (from) filter.startTime.$gte = new Date(from);
      if (to)   filter.startTime.$lte = new Date(to);
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [docs, total] = await Promise.all([
      TeacherSchedule.find(filter)
        .select('-__v')
        .populate('subject', 'subject_name subject_code')
        .populate('classes', 'className')
        .populate('teacher', 'firstName lastName')
        .sort({ startTime: 1 })
        .skip(skip).limit(Number(limit)).lean(),
      TeacherSchedule.countDocuments(filter),
    ]);

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
