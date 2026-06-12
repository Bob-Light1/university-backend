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
const Mentor            = require('../mentor.model');
// Cross-domaine : anciens chemins tant que ces domaines ne sont pas des modules (§6)
const Result            = require('../../../models/result.model');
const StudentAttendance = require('../../../models/student-models/student.attend.model');
const Course            = require('../../../models/course.model');
const Student           = require('../../../models/student-models/student.model');

const {
  sendSuccess,
  sendError,
  sendNotFound,
  sendPaginated,
} = require('../../../shared/utils/response-helpers');

// ── Helpers ───────────────────────────────────────────────────────────────────

const toOid  = (id) => new mongoose.Types.ObjectId(id);

/**
 * Loads the mentor document to get their students[] and classes[].
 * Returns null and sends 404 if not found.
 */
const loadMentor = async (req, res) => {
  const mentor = await Mentor.findOne({
    _id:          toOid(req.user.id),
    schoolCampus: toOid(req.user.campusId),
  }).select('students classes schoolCampus').lean();

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
      Student.countDocuments({ _id: { $in: studentIds } }),

      // Active students
      Student.countDocuments({ _id: { $in: studentIds }, status: 'active' }),

      // Total results published for their students
      studentIds.length
        ? Result.countDocuments({
            student:      { $in: studentIds },
            schoolCampus: campusId,
            status:       'PUBLISHED',
          })
        : 0,

      // Attendance summary: total & present for their classes
      classIds.length
        ? StudentAttendance.aggregate([
            { $match: { class: { $in: classIds }, schoolCampus: campusId } },
            {
              $group: {
                _id:     null,
                total:   { $sum: 1 },
                present: { $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } },
              },
            },
          ])
        : Promise.resolve([]),

      // Last 5 published results for their students
      studentIds.length
        ? Result.find({
            student:      { $in: studentIds },
            schoolCampus: campusId,
            status:       'PUBLISHED',
          })
            .select('student subject score maxScore grade evaluationTitle createdAt')
            .populate('student', 'firstName lastName profileImage')
            .populate('subject', 'subject_name')
            .sort({ createdAt: -1 })
            .limit(5)
            .lean()
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

    const filter = { _id: { $in: studentIds } };
    if (status)  filter.status = status;
    if (classId) filter.studentClass = classId;
    if (search) {
      const rx = new RegExp(search.trim(), 'i');
      filter.$or = [{ firstName: rx }, { lastName: rx }, { email: rx }, { matricule: rx }];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [docs, total] = await Promise.all([
      Student.find(filter)
        .select('-password -__v')
        .populate('studentClass', 'className')
        .populate('schoolCampus', 'campus_name')
        .sort({ lastName: 1, firstName: 1 })
        .skip(skip)
        .limit(Number(limit))
        .lean({ virtuals: true }),
      Student.countDocuments(filter),
    ]);

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

    const filter = {
      student:      { $in: studentIds },
      schoolCampus: toOid(req.user.campusId),
      status:       'PUBLISHED',
    };

    if (studentId   && studentIds.map(String).includes(studentId)) {
      filter.student = toOid(studentId);
    }
    if (subjectId)   filter.subject      = toOid(subjectId);
    if (academicYear) filter.academicYear = academicYear;
    if (semester)    filter.semester      = semester;

    const skip = (Number(page) - 1) * Number(limit);
    const [docs, total] = await Promise.all([
      Result.find(filter)
        .select('-__v')
        .populate('student', 'firstName lastName matricule profileImage')
        .populate('subject', 'subject_name')
        .populate('class',   'className')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Result.countDocuments(filter),
    ]);

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

    const filter = { schoolCampus: toOid(req.user.campusId) };

    // Scope: either a specific class (must belong to mentor) or all their classes
    if (classId) {
      if (!classIds.map(String).includes(classId)) {
        return sendError(res, 403, 'This class is not assigned to you.');
      }
      filter.class = toOid(classId);
    } else if (classIds.length) {
      filter.class = { $in: classIds };
    }

    // Optionally further filter to a specific student
    if (studentId) {
      if (!studentIds.map(String).includes(studentId)) {
        return sendError(res, 403, 'This student is not assigned to you.');
      }
      filter.student = toOid(studentId);
    }

    if (status) filter.status = status;
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
        .populate('class',   'className')
        .sort({ attendanceDate: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      StudentAttendance.countDocuments(filter),
    ]);

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

    const filter = {
      approvalStatus: 'APPROVED',
      isLatestVersion: true,
      status: { $ne: 'archived' },
    };

    if (search) {
      const rx = new RegExp(search.trim(), 'i');
      filter.$or = [{ title: rx }, { courseCode: rx }, { description: rx }];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [docs, total] = await Promise.all([
      Course.find(filter)
        .select('-__v')
        .populate('subject', 'subject_name')
        .populate('createdBy', 'firstName lastName')
        .sort({ title: 1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Course.countDocuments(filter),
    ]);

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
