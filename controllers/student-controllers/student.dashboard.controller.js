'use strict';

/**
 * @file student.dashboard.controller.js
 * @description Aggregated dashboard KPIs for the STUDENT self-service portal.
 *
 *  Route (prefixed /api/students):
 *    GET /me/dashboard → getDashboard   [STUDENT]
 *
 *  Returns in one round-trip:
 *   - Student profile (class, campus, mentor)
 *   - Today's schedule sessions
 *   - Upcoming sessions (next 7 days)
 *   - Current-year attendance summary
 *   - Last 5 published results + computed average
 *   - Upcoming exam enrollments (eligible, future sessions)
 */

const mongoose = require('mongoose');

const Student          = require('../../models/student-models/student.model');
const StudentSchedule  = require('../../models/student-models/studentSchedule.model');
const StudentAttendance = require('../../models/student-models/studentAttend.model');
const { Result }       = require('../../models/result.model');
const ExamEnrollment   = require('../../models/exam-models/examEnrollment.model');
const {
  sendSuccess,
  sendError,
  sendNotFound,
} = require('../../utils/responseHelpers');

// ── helpers ───────────────────────────────────────────────────────────────────

const toObjectId = (id) => {
  try { return new mongoose.Types.ObjectId(id); } catch { return null; }
};

const currentAcademicYear = () => {
  const now  = new Date();
  const year = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-${year + 1}`;
};

// ── getDashboard ──────────────────────────────────────────────────────────────

const getDashboard = async (req, res) => {
  try {
    const studentId = req.user.id;

    // ── 1. Student profile ────────────────────────────────────────────────────
    const student = await Student.findById(studentId)
      .populate('studentClass', 'className level')
      .populate('schoolCampus', 'campus_name')
      .populate('mentor',       'firstName lastName email')
      .lean({ virtuals: true });

    if (!student) return sendNotFound(res, 'Student');

    // ── 2. Time windows ───────────────────────────────────────────────────────
    const now        = new Date();
    const todayStart = new Date(now); todayStart.setHours(0,  0,  0,  0);
    const todayEnd   = new Date(now); todayEnd.setHours(23, 59, 59, 999);
    const weekEnd    = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const acYear     = currentAcademicYear();

    const classId  = student.studentClass?._id;
    const campusOid = toObjectId(
      student.schoolCampus?._id ?? student.schoolCampus
    );

    // ── 3. Parallel queries ───────────────────────────────────────────────────
    const scheduleFilter = (extraTime) => ({
      'classes.classId': classId,
      schoolCampus:      campusOid,
      status:            'PUBLISHED',
      isDeleted:         false,
      ...extraTime,
    });

    const [
      todaySessions,
      upcomingSessions,
      attendanceStats,
      recentResults,
      examEnrollments,
    ] = await Promise.all([

      // Today's sessions
      classId
        ? StudentSchedule.find(scheduleFilter({ startTime: { $gte: todayStart, $lte: todayEnd } }))
            .sort({ startTime: 1 }).lean()
        : Promise.resolve([]),

      // Next 7 days (beyond today)
      classId
        ? StudentSchedule.find(scheduleFilter({ startTime: { $gt: todayEnd, $lte: weekEnd } }))
            .sort({ startTime: 1 }).limit(8).lean()
        : Promise.resolve([]),

      // Current-year attendance summary
      campusOid
        ? StudentAttendance.aggregate([
            {
              $match: {
                student:      toObjectId(studentId),
                schoolCampus: campusOid,
                academicYear: acYear,
              },
            },
            {
              $group: {
                _id:           null,
                totalSessions: { $sum: 1 },
                presentCount:  { $sum: { $cond: [{ $eq: ['$status', true]  }, 1, 0] } },
                absentCount:   { $sum: { $cond: [{ $eq: ['$status', false] }, 1, 0] } },
              },
            },
          ])
        : Promise.resolve([]),

      // Last 5 published results
      Result.find({
        student:      studentId,
        schoolCampus: campusOid,
        status:       'PUBLISHED',
        isDeleted:    false,
      })
        .select('evaluationTitle evaluationType academicYear semester normalizedScore score maxScore gradeBand publishedAt subject')
        .populate('subject', 'subject_name subject_code')
        .sort({ publishedAt: -1 })
        .limit(5)
        .lean({ virtuals: true }),

      // Upcoming exam enrollments (eligible + session in the future)
      // Note: .sort() on a populated field is not supported by Mongoose — sorting
      // is done in JS after the populate+match filter removes null examSessions.
      ExamEnrollment.find({
        student:    studentId,
        isEligible: true,
        isDeleted:  false,
      })
        .populate({
          path:     'examSession',
          match:    { status: { $in: ['SCHEDULED', 'PUBLISHED', 'ONGOING'] }, startTime: { $gte: now }, isDeleted: false },
          select:   'title startTime endTime status room subject',
          populate: { path: 'subject', select: 'subject_name' },
        })
        .lean(),
    ]);

    // ── 4. Derived stats ──────────────────────────────────────────────────────
    const att = attendanceStats[0] ?? { totalSessions: 0, presentCount: 0, absentCount: 0 };
    att.attendanceRate = att.totalSessions > 0
      ? parseFloat(((att.presentCount / att.totalSessions) * 100).toFixed(1))
      : 0;

    const avgScore = recentResults.length
      ? parseFloat((recentResults.reduce((s, r) => s + (r.normalizedScore ?? 0), 0) / recentResults.length).toFixed(1))
      : null;

    // populate + match → un-matched docs have examSession=null; filter them out,
    // then sort chronologically in JS (Mongoose cannot sort on populated fields).
    const upcomingExams = examEnrollments
      .filter((e) => e.examSession != null)
      .sort((a, b) => new Date(a.examSession.startTime) - new Date(b.examSession.startTime))
      .slice(0, 5);

    return sendSuccess(res, 200, 'Dashboard retrieved.', {
      student: {
        id:             student._id,
        firstName:      student.firstName,
        lastName:       student.lastName,
        email:          student.email,
        profileImage:   student.profileImage,
        matricule:      student.matricule,
        studentClass:   student.studentClass,
        campus:         student.schoolCampus,
        mentor:         student.mentor,
        enrollmentDate: student.enrollmentDate,
        status:         student.status,
      },
      academicYear: acYear,
      stats: {
        attendanceRate:    att.attendanceRate,
        totalSessions:     att.totalSessions,
        absentCount:       att.absentCount,
        avgScore,
        upcomingExamCount: upcomingExams.length,
        todaySessionCount: todaySessions.length,
      },
      todaySessions,
      upcomingSessions,
      recentResults,
      upcomingExams,
    });
  } catch (err) {
    console.error('❌ student getDashboard:', err);
    return sendError(res, 500, 'Failed to retrieve student dashboard.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

module.exports = { getDashboard };
