'use strict';

/**
 * @file parent_portal_controller.js
 * @description Read-only portal endpoints for the PARENT role.
 *
 *  All endpoints require JWT role=PARENT.
 *  Campus isolation is enforced via parent.schoolCampus on every query.
 *  Only PUBLISHED + non-deleted records are exposed.
 *
 *  Routes handled:
 *  ─────────────────────────────────────────────────────────────────────────────
 *  GET  /api/parents/me/children                     → getChildren
 *  GET  /api/parents/me/children/:studentId/results  → getChildResults
 *  GET  /api/parents/me/children/:studentId/transcripts → getChildTranscripts
 *  POST /api/parents/me/children/:studentId/transcripts/:transcriptId/sign → signTranscript
 *  GET  /api/parents/me/children/:studentId/schedule → getChildSchedule
 *  GET  /api/parents/me/children/:studentId/attendance → getChildAttendance
 *  GET  /api/parents/me/children/:studentId/teachers → getChildTeachers
 *  GET  /api/parents/me/children/:studentId/comments → getChildComments
 *  GET  /api/parents/me/dashboard                    → getDashboard
 */

const mongoose = require('mongoose');

const Parent              = require('../../models/parent.model');
const Student             = require('../../models/student-models/student.model');
const { Result }          = require('../../models/result.model');
const { FinalTranscript } = require('../../models/finalTranscript.model');
const StudentAttendance   = require('../../models/student-models/studentAttend.model');
const StudentSchedule     = require('../../models/student-models/studentSchedule.model');
const {
  sendSuccess,
  sendError,
  sendNotFound,
} = require('../../utils/responseHelpers');

// ── CONSTANTS ─────────────────────────────────────────────────────────────────

const DEFAULT_PAGE  = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT     = 100;

// ── HELPERS ───────────────────────────────────────────────────────────────────

/**
 * Parses ?page and ?limit query params with safe defaults.
 * @returns {{ skip: number, limit: number, page: number }}
 */
const parsePagination = (query) => {
  const page  = Math.max(1, parseInt(query.page,  10) || DEFAULT_PAGE);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(query.limit, 10) || DEFAULT_LIMIT));
  return { page, limit, skip: (page - 1) * limit };
};

/**
 * Verifies that a given studentId belongs to the authenticated parent.
 * Returns the parent document (with schoolCampus) if ownership is confirmed.
 * Throws a 403-coded Error on failure — never 404 to avoid existence leakage.
 *
 * @param {string} parentId   - req.user.id
 * @param {string} studentId  - req.params.studentId
 * @returns {Promise<ParentDocument>}
 */
const verifyChildOwnership = async (parentId, studentId) => {
  if (!mongoose.Types.ObjectId.isValid(studentId)) {
    const err = new Error('Invalid student ID.');
    err.statusCode = 400;
    throw err;
  }

  const parent = await Parent.findById(parentId).select('schoolCampus children').lean();
  if (!parent) {
    const err = new Error('Parent account not found.');
    err.statusCode = 403;
    throw err;
  }

  const owns = parent.children.some((id) => id.toString() === studentId.toString());
  if (!owns) {
    // Always 403 — never reveal whether the student actually exists
    const err = new Error('Access denied: student is not linked to your account.');
    err.statusCode = 403;
    throw err;
  }

  return parent;
};

// ── GET CHILDREN ──────────────────────────────────────────────────────────────

/**
 * Return the parent's linked children with basic profile info.
 *
 * @route  GET /api/parents/me/children
 * @access PARENT
 */
const getChildren = async (req, res) => {
  try {
    const parent = await Parent.findById(req.user.id)
      .select('children schoolCampus')
      .populate('children', 'firstName lastName profileImage studentClass status schoolCampus')
      .lean({ virtuals: true });

    if (!parent) {
      return sendNotFound(res, 'Parent');
    }

    return sendSuccess(res, 200, 'Children retrieved successfully.', {
      total:    parent.children?.length ?? 0,
      children: parent.children ?? [],
    });

  } catch (error) {
    console.error('❌ getChildren error:', error);
    return sendError(res, 500, 'Failed to retrieve children.');
  }
};

// ── GET CHILD RESULTS ─────────────────────────────────────────────────────────

/**
 * Return PUBLISHED results for one child, paginated.
 *
 * Query params: ?page, ?limit, ?academicYear, ?semester, ?subject
 *
 * @route  GET /api/parents/me/children/:studentId/results
 * @access PARENT
 */
const getChildResults = async (req, res) => {
  try {
    const { studentId } = req.params;
    const parent = await verifyChildOwnership(req.user.id, studentId);

    const { page, limit, skip } = parsePagination(req.query);

    const filter = {
      student:      studentId,
      schoolCampus: parent.schoolCampus,
      status:       'PUBLISHED',
      isDeleted:    false,
    };

    if (req.query.academicYear) filter.academicYear = req.query.academicYear;
    if (req.query.semester)     filter.semester     = req.query.semester;
    if (req.query.subject && mongoose.Types.ObjectId.isValid(req.query.subject)) {
      filter.subject = req.query.subject;
    }

    const [results, total] = await Promise.all([
      Result.find(filter)
        .select('-auditLog -verificationToken -dropoutRiskScore -__v')
        .populate('subject',  'subject_name subject_code')
        .populate('teacher',  'firstName lastName email')
        .populate('class',    'className level')
        .sort({ examDate: -1, publishedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean({ virtuals: true }),
      Result.countDocuments(filter),
    ]);

    return sendSuccess(res, 200, 'Results retrieved successfully.', {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      results,
    });

  } catch (error) {
    if (error.statusCode) {
      return sendError(res, error.statusCode, error.message);
    }
    console.error('❌ getChildResults error:', error);
    return sendError(res, 500, 'Failed to retrieve results.');
  }
};

// ── GET CHILD TRANSCRIPTS ─────────────────────────────────────────────────────

/**
 * Return VALIDATED or SEALED final transcripts for one child.
 *
 * Query params: ?academicYear, ?semester
 *
 * @route  GET /api/parents/me/children/:studentId/transcripts
 * @access PARENT
 */
const getChildTranscripts = async (req, res) => {
  try {
    const { studentId } = req.params;
    const parent = await verifyChildOwnership(req.user.id, studentId);

    const filter = {
      student:      studentId,
      schoolCampus: parent.schoolCampus,
      status:       { $in: ['VALIDATED', 'SEALED'] },
    };

    if (req.query.academicYear) filter.academicYear = req.query.academicYear;
    if (req.query.semester)     filter.semester     = req.query.semester;

    const transcripts = await FinalTranscript.find(filter)
      .select('-__v')
      .populate('class',   'className level')
      .populate('student', 'firstName lastName profileImage')
      .sort({ academicYear: -1, semester: 1 })
      .lean({ virtuals: true });

    return sendSuccess(res, 200, 'Transcripts retrieved successfully.', {
      total:       transcripts.length,
      transcripts,
    });

  } catch (error) {
    if (error.statusCode) {
      return sendError(res, error.statusCode, error.message);
    }
    console.error('❌ getChildTranscripts error:', error);
    return sendError(res, 500, 'Failed to retrieve transcripts.');
  }
};

// ── SIGN TRANSCRIPT ───────────────────────────────────────────────────────────

/**
 * Record the parent's digital acknowledgement of a final transcript.
 *
 * The transcript must be VALIDATED or SEALED and not yet signed.
 *
 * @route  POST /api/parents/me/children/:studentId/transcripts/:transcriptId/sign
 * @access PARENT
 */
const signTranscript = async (req, res) => {
  try {
    const { studentId, transcriptId } = req.params;
    const parent = await verifyChildOwnership(req.user.id, studentId);

    if (!mongoose.Types.ObjectId.isValid(transcriptId)) {
      return sendError(res, 400, 'Invalid transcript ID.');
    }

    const transcript = await FinalTranscript.findOne({
      _id:          transcriptId,
      student:      studentId,
      schoolCampus: parent.schoolCampus,
    });

    if (!transcript) {
      return sendNotFound(res, 'Transcript');
    }

    // signByParent throws if already signed or wrong status
    await transcript.signByParent(req.user.id, req.ip, 'click');

    return sendSuccess(res, 200, 'Transcript signed successfully.', {
      transcriptId:    transcript._id,
      parentSignature: transcript.parentSignature,
    });

  } catch (error) {
    if (error.statusCode) {
      return sendError(res, error.statusCode, error.message);
    }
    // signByParent throws plain Errors — surface them as 400
    if (error.message?.includes('already been signed') || error.message?.includes('Only VALIDATED')) {
      return sendError(res, 400, error.message);
    }
    console.error('❌ signTranscript error:', error);
    return sendError(res, 500, 'Failed to sign transcript.');
  }
};

// ── GET CHILD SCHEDULE ────────────────────────────────────────────────────────

/**
 * Return upcoming schedule sessions (next 7 days) for one child.
 * Only PUBLISHED, non-deleted sessions are returned.
 *
 * Query params: ?days (1–30, defaults to 7)
 *
 * @route  GET /api/parents/me/children/:studentId/schedule
 * @access PARENT
 */
const getChildSchedule = async (req, res) => {
  try {
    const { studentId } = req.params;
    const parent = await verifyChildOwnership(req.user.id, studentId);

    // Resolve the student's current class
    const student = await Student.findOne({
      _id:          studentId,
      schoolCampus: parent.schoolCampus,
    }).select('studentClass').lean();

    if (!student) {
      return sendNotFound(res, 'Student');
    }

    const days    = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 7));
    const now     = new Date();
    const endDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const schedule = await StudentSchedule.find({
      'classes.classId': student.studentClass,
      schoolCampus:      parent.schoolCampus,
      status:            'PUBLISHED',
      isDeleted:         false,
      startTime:         { $gte: now, $lte: endDate },
    })
      .select('-attendance -postponementRequests -__v')
      .sort({ startTime: 1 })
      .lean({ virtuals: true });

    return sendSuccess(res, 200, 'Schedule retrieved successfully.', {
      total:    schedule.length,
      days,
      schedule,
    });

  } catch (error) {
    if (error.statusCode) {
      return sendError(res, error.statusCode, error.message);
    }
    console.error('❌ getChildSchedule error:', error);
    return sendError(res, 500, 'Failed to retrieve schedule.');
  }
};

// ── GET CHILD ATTENDANCE ──────────────────────────────────────────────────────

/**
 * Return attendance records for one child, paginated.
 *
 * Query params: ?page, ?limit, ?academicYear, ?semester, ?status (true|false)
 *
 * @route  GET /api/parents/me/children/:studentId/attendance
 * @access PARENT
 */
const getChildAttendance = async (req, res) => {
  try {
    const { studentId } = req.params;
    const parent = await verifyChildOwnership(req.user.id, studentId);

    const { page, limit, skip } = parsePagination(req.query);

    const filter = {
      student:      studentId,
      schoolCampus: parent.schoolCampus,
    };

    if (req.query.academicYear) filter.academicYear = req.query.academicYear;
    if (req.query.semester)     filter.semester     = req.query.semester;
    if (req.query.status !== undefined) {
      filter.status = req.query.status === 'true';
    }

    const [records, total, stats] = await Promise.all([
      StudentAttendance.find(filter)
        .select('-__v')
        .populate('subject',   'subject_name')
        .populate('recordedBy','firstName lastName')
        .sort({ attendanceDate: -1 })
        .skip(skip)
        .limit(limit)
        .lean({ virtuals: true }),
      StudentAttendance.countDocuments(filter),
      // Aggregate summary (all records, not just current page)
      StudentAttendance.aggregate([
        { $match: { ...filter, student: new mongoose.Types.ObjectId(studentId) } },
        {
          $group: {
            _id:              null,
            totalSessions:    { $sum: 1 },
            presentCount:     { $sum: { $cond: [{ $eq: ['$status', true]  }, 1, 0] } },
            absentCount:      { $sum: { $cond: [{ $eq: ['$status', false] }, 1, 0] } },
            justifiedAbsences:{ $sum: { $cond: ['$isJustified', 1, 0] } },
          },
        },
      ]),
    ]);

    const summary = stats[0] ?? {
      totalSessions: 0, presentCount: 0, absentCount: 0, justifiedAbsences: 0,
    };
    if (summary.totalSessions > 0) {
      summary.attendanceRate = parseFloat(
        ((summary.presentCount / summary.totalSessions) * 100).toFixed(1)
      );
    } else {
      summary.attendanceRate = 0;
    }

    return sendSuccess(res, 200, 'Attendance retrieved successfully.', {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      summary,
      records,
    });

  } catch (error) {
    if (error.statusCode) {
      return sendError(res, error.statusCode, error.message);
    }
    console.error('❌ getChildAttendance error:', error);
    return sendError(res, 500, 'Failed to retrieve attendance.');
  }
};

// ── GET CHILD TEACHERS ────────────────────────────────────────────────────────

/**
 * Return the distinct teachers currently scheduled for one child's class.
 * Derived from PUBLISHED StudentSchedule entries.
 *
 * @route  GET /api/parents/me/children/:studentId/teachers
 * @access PARENT
 */
const getChildTeachers = async (req, res) => {
  try {
    const { studentId } = req.params;
    const parent = await verifyChildOwnership(req.user.id, studentId);

    const student = await Student.findOne({
      _id:          studentId,
      schoolCampus: parent.schoolCampus,
    }).select('studentClass').lean();

    if (!student) {
      return sendNotFound(res, 'Student');
    }

    // Distinct teachers from published sessions for this class
    const sessions = await StudentSchedule.find({
      'classes.classId': student.studentClass,
      schoolCampus:      parent.schoolCampus,
      status:            'PUBLISHED',
      isDeleted:         false,
    })
      .select('teacher subject')
      .lean();

    // De-duplicate by teacherId
    const teacherMap = new Map();
    for (const s of sessions) {
      if (!s.teacher?.teacherId) continue;
      const tid = s.teacher.teacherId.toString();
      if (!teacherMap.has(tid)) {
        teacherMap.set(tid, {
          teacherId: s.teacher.teacherId,
          firstName: s.teacher.firstName,
          lastName:  s.teacher.lastName,
          email:     s.teacher.email,
          subjects:  [],
        });
      }
      if (s.subject?.subjectId) {
        const teacher = teacherMap.get(tid);
        const already = teacher.subjects.some(
          (sub) => sub.subjectId?.toString() === s.subject.subjectId.toString()
        );
        if (!already) {
          teacher.subjects.push({
            subjectId:    s.subject.subjectId,
            subject_name: s.subject.subject_name,
            subject_code: s.subject.subject_code,
          });
        }
      }
    }

    const teachers = Array.from(teacherMap.values());

    return sendSuccess(res, 200, 'Teachers retrieved successfully.', {
      total: teachers.length,
      teachers,
    });

  } catch (error) {
    if (error.statusCode) {
      return sendError(res, error.statusCode, error.message);
    }
    console.error('❌ getChildTeachers error:', error);
    return sendError(res, 500, 'Failed to retrieve teachers.');
  }
};

// ── GET CHILD COMMENTS ────────────────────────────────────────────────────────

/**
 * Return pedagogical feedback (teacherRemarks, classManagerRemarks,
 * strengths, improvements) from PUBLISHED results, paginated.
 *
 * Only returns records that have at least one comment field.
 *
 * Query params: ?page, ?limit, ?academicYear, ?semester
 *
 * @route  GET /api/parents/me/children/:studentId/comments
 * @access PARENT
 */
const getChildComments = async (req, res) => {
  try {
    const { studentId } = req.params;
    const parent = await verifyChildOwnership(req.user.id, studentId);

    const { page, limit, skip } = parsePagination(req.query);

    const filter = {
      student:      studentId,
      schoolCampus: parent.schoolCampus,
      status:       'PUBLISHED',
      isDeleted:    false,
      // At least one comment field must exist
      $or: [
        { teacherRemarks:       { $exists: true, $ne: null, $ne: '' } },
        { classManagerRemarks:  { $exists: true, $ne: null, $ne: '' } },
        { strengths:            { $exists: true, $ne: null, $ne: '' } },
        { improvements:         { $exists: true, $ne: null, $ne: '' } },
      ],
    };

    if (req.query.academicYear) filter.academicYear = req.query.academicYear;
    if (req.query.semester)     filter.semester     = req.query.semester;

    const [comments, total] = await Promise.all([
      Result.find(filter)
        .select('academicYear semester evaluationTitle evaluationType teacherRemarks classManagerRemarks strengths improvements publishedAt subject teacher')
        .populate('subject', 'subject_name subject_code')
        .populate('teacher', 'firstName lastName')
        .sort({ publishedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean({ virtuals: true }),
      Result.countDocuments(filter),
    ]);

    return sendSuccess(res, 200, 'Comments retrieved successfully.', {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      comments,
    });

  } catch (error) {
    if (error.statusCode) {
      return sendError(res, error.statusCode, error.message);
    }
    console.error('❌ getChildComments error:', error);
    return sendError(res, 500, 'Failed to retrieve comments.');
  }
};

// ── DASHBOARD ─────────────────────────────────────────────────────────────────

/**
 * Return an overview for all linked children in a single call.
 * Uses Promise.all to avoid N+1 sequential queries.
 *
 * Per child: last 5 results, attendance rate (current year), upcoming sessions (3).
 *
 * @route  GET /api/parents/me/dashboard
 * @access PARENT
 */
const getDashboard = async (req, res) => {
  try {
    const parent = await Parent.findById(req.user.id)
      .select('children schoolCampus firstName lastName')
      .populate('children', 'firstName lastName profileImage studentClass status')
      .lean({ virtuals: true });

    if (!parent) {
      return sendNotFound(res, 'Parent');
    }

    const children = parent.children ?? [];
    const campusId = parent.schoolCampus;

    // Infer current academic year (e.g. "2025-2026")
    const now   = new Date();
    const year  = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
    const currentAcademicYear = `${year}-${year + 1}`;
    const sevenDaysFromNow    = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Parallel across all children
    const childSummaries = await Promise.all(
      children.map(async (child) => {
        const studentId  = child._id;
        const classId    = child.studentClass;

        const [recentResults, attendanceStats, upcomingSessions] = await Promise.all([

          // Last 5 published results
          Result.find({
            student:      studentId,
            schoolCampus: campusId,
            status:       'PUBLISHED',
            isDeleted:    false,
          })
            .select('evaluationTitle evaluationType academicYear semester normalizedScore gradeBand publishedAt subject')
            .populate('subject', 'subject_name')
            .sort({ publishedAt: -1 })
            .limit(5)
            .lean({ virtuals: true }),

          // Current-year attendance summary
          StudentAttendance.aggregate([
            {
              $match: {
                student:      new mongoose.Types.ObjectId(studentId),
                schoolCampus: new mongoose.Types.ObjectId(campusId),
                academicYear: currentAcademicYear,
              },
            },
            {
              $group: {
                _id:          null,
                totalSessions:{ $sum: 1 },
                presentCount: { $sum: { $cond: [{ $eq: ['$status', true] }, 1, 0] } },
                absentCount:  { $sum: { $cond: [{ $eq: ['$status', false] }, 1, 0] } },
              },
            },
          ]),

          // Next 3 sessions
          classId
            ? StudentSchedule.find({
                'classes.classId': classId,
                schoolCampus:      campusId,
                status:            'PUBLISHED',
                isDeleted:         false,
                startTime:         { $gte: now, $lte: sevenDaysFromNow },
              })
                .select('subject teacher startTime endTime sessionType room isVirtual')
                .sort({ startTime: 1 })
                .limit(3)
                .lean()
            : Promise.resolve([]),
        ]);

        const stats = attendanceStats[0] ?? { totalSessions: 0, presentCount: 0, absentCount: 0 };
        stats.attendanceRate = stats.totalSessions > 0
          ? parseFloat(((stats.presentCount / stats.totalSessions) * 100).toFixed(1))
          : 0;

        return {
          student: {
            id:           child._id,
            firstName:    child.firstName,
            lastName:     child.lastName,
            profileImage: child.profileImage ?? null,
            status:       child.status,
            studentClass: child.studentClass,
          },
          recentResults,
          attendance:     stats,
          upcomingSessions,
        };
      })
    );

    return sendSuccess(res, 200, 'Dashboard retrieved successfully.', {
      parent: {
        id:        parent._id,
        firstName: parent.firstName,
        lastName:  parent.lastName,
        campusId,
      },
      academicYear: currentAcademicYear,
      childCount:   children.length,
      children:     childSummaries,
    });

  } catch (error) {
    console.error('❌ getDashboard error:', error);
    return sendError(res, 500, 'Failed to retrieve dashboard.');
  }
};

// ── EXPORTS ───────────────────────────────────────────────────────────────────

module.exports = {
  getChildren,
  getChildResults,
  getChildTranscripts,
  signTranscript,
  getChildSchedule,
  getChildAttendance,
  getChildTeachers,
  getChildComments,
  getDashboard,
};
