'use strict';

/**
 * @file teacher.dashboard.controller.js
 * @description Aggregated dashboard KPIs for the TEACHER self-service portal.
 *
 *  Route (all prefixed /api/teachers):
 *    GET /me/dashboard → getDashboard   [TEACHER]
 *
 *  Returns in one round-trip:
 *   - Teacher profile (subjects, classes, department)
 *   - Today's sessions
 *   - Upcoming sessions (next 7 days)
 *   - Pending roll-calls (past published sessions not yet submitted)
 *   - Academic-year workload stats (sessions, hours delivered)
 *   - Grading queue count (submissions assigned to teacher, not yet graded)
 *   - Total students across teacher's classes
 */

const mongoose = require('mongoose');

const Teacher        = require('../../models/teacher-models/teacher.model');
const TeacherSchedule = require('../../models/teacher-models/teacherSchedule.model');
const Student        = require('../../models/student-models/student.model');
const ExamGrading    = require('../../models/exam-models/examGrading.model');
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
    const teacherId = req.user.id;

    // ── 1. Teacher profile ────────────────────────────────────────────────────
    const teacher = await Teacher.findById(teacherId)
      .populate('subjects',      'subject_name subject_code')
      .populate('classes',       'className level')
      .populate('department',    'name')
      .populate('schoolCampus',  'campus_name')
      .lean({ virtuals: true });

    if (!teacher) return sendNotFound(res, 'Teacher');

    // ── 2. Time windows ───────────────────────────────────────────────────────
    const now        = new Date();
    const todayStart = new Date(now); todayStart.setHours(0,  0,  0,  0);
    const todayEnd   = new Date(now); todayEnd.setHours(23, 59, 59, 999);
    const weekEnd    = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const acYear     = currentAcademicYear();

    const classIds = (teacher.classes || []).map((c) => c._id);

    // ── 3. Parallel queries ───────────────────────────────────────────────────
    const [
      todaySessions,
      upcomingSessions,
      pendingRollCalls,
      workload,
      gradingQueueCount,
      totalStudents,
    ] = await Promise.all([

      // Sessions happening today
      TeacherSchedule.find({
        'teacher.teacherId': teacherId,
        status:    'PUBLISHED',
        isDeleted: false,
        startTime: { $gte: todayStart, $lte: todayEnd },
      }).sort({ startTime: 1 }).lean(),

      // Sessions in the next 7 days (excluding today)
      TeacherSchedule.find({
        'teacher.teacherId': teacherId,
        status:    'PUBLISHED',
        isDeleted: false,
        startTime: { $gt: todayEnd, $lte: weekEnd },
      }).sort({ startTime: 1 }).limit(8).lean(),

      // Past published sessions where the roll-call was never submitted
      TeacherSchedule.find({
        'teacher.teacherId':   teacherId,
        status:                'PUBLISHED',
        isDeleted:             false,
        startTime:             { $lt: todayStart },
        'rollCall.submitted':  false,
      }).sort({ startTime: -1 }).limit(10).lean(),

      // Academic-year workload aggregate
      TeacherSchedule.aggregate([
        {
          $match: {
            'teacher.teacherId': toObjectId(teacherId),
            status:              'PUBLISHED',
            isDeleted:           false,
            academicYear:        acYear,
          },
        },
        {
          $group: {
            _id:               null,
            totalSessions:     { $sum: 1 },
            deliveredSessions: { $sum: { $cond: ['$rollCall.submitted', 1, 0] } },
            scheduledMinutes:  { $sum: '$durationMinutes' },
            deliveredMinutes:  { $sum: { $cond: ['$rollCall.submitted', '$durationMinutes', 0] } },
          },
        },
      ]),

      // Submissions assigned to this teacher not yet graded (status PENDING)
      ExamGrading.countDocuments({
        grader:    toObjectId(teacherId),
        status:    'PENDING',
        isDeleted: false,
      }),

      // Active students in teacher's classes
      classIds.length
        ? Student.countDocuments({
            studentClass: { $in: classIds },
            status:       'active',
          })
        : Promise.resolve(0),
    ]);

    // ── 4. Derived stats ──────────────────────────────────────────────────────
    const wl = workload[0] ?? {
      totalSessions: 0, deliveredSessions: 0,
      scheduledMinutes: 0, deliveredMinutes: 0,
    };
    const scheduledHours = parseFloat(((wl.scheduledMinutes ?? 0) / 60).toFixed(1));
    const deliveredHours  = parseFloat(((wl.deliveredMinutes  ?? 0) / 60).toFixed(1));

    return sendSuccess(res, 200, 'Dashboard retrieved.', {
      teacher: {
        id:             teacher._id,
        firstName:      teacher.firstName,
        lastName:       teacher.lastName,
        email:          teacher.email,
        profileImage:   teacher.profileImage,
        status:         teacher.status,
        campus:         teacher.schoolCampus,
        qualification:  teacher.qualification,
        specialization: teacher.specialization,
        employmentType: teacher.employmentType,
        experience:     teacher.experience,
        hireDate:       teacher.hireDate,
        matricule:      teacher.matricule,
        department:     teacher.department,
        subjects:       teacher.subjects || [],
        classes:        teacher.classes  || [],
      },
      academicYear: acYear,
      stats: {
        totalStudents,
        subjectCount:         (teacher.subjects || []).length,
        classCount:           (teacher.classes  || []).length,
        totalSessions:        wl.totalSessions,
        deliveredSessions:    wl.deliveredSessions,
        scheduledHours,
        deliveredHours,
        gradingQueueCount,
        pendingRollCallCount: pendingRollCalls.length,
        todaySessionCount:    todaySessions.length,
      },
      todaySessions,
      upcomingSessions,
      pendingRollCalls,
    });
  } catch (err) {
    console.error('❌ teacher getDashboard:', err);
    return sendError(res, 500, 'Failed to retrieve teacher dashboard.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

module.exports = { getDashboard };
