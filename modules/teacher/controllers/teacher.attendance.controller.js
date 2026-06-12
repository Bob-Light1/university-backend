'use strict';

/**
 * @file teacher.attendance.controller.js
 * @description Controller for teacher attendance management.
 *
 *  JWT payload (foruni) :
 *    req.user.id        → string (ID teacher dans le JWT)
 *    req.user.role      → 'ADMIN' | 'DIRECTOR' | 'CAMPUS_MANAGER' | 'TEACHER' | 'STUDENT'
 *    req.user.campusId  → string ObjectId campus (absent pour ADMIN/DIRECTOR)
 */

const mongoose          = require('mongoose');
const TeacherAttendance = require('../models/teacher.attend.model');
const TeacherSchedule   = require('../models/teacher.schedule.model');

const {
  asyncHandler,
  sendSuccess,
  sendError,
  sendCreated,
  sendPaginated,
  sendNotFound,
  sendForbidden,
} = require('../../../shared/utils/response-helpers');

const {
  isValidObjectId,
} = require('../../../shared/utils/validation-helpers');
const { validateTeacherBelongsToCampus } = require('../teacher.service');

// ─── HELPERS ────────────────────────────────────────────────────────────────

const isGlobalRole = (role) => role === 'ADMIN' || role === 'DIRECTOR';

const buildCampusFilter = (req) => {
  if (isGlobalRole(req.user.role)) return {};
  if (!req.user.campusId) {
    const err = new Error('Campus information not found in your account.');
    err.statusCode = 403;
    throw err;
  }
  return { schoolCampus: new mongoose.Types.ObjectId(req.user.campusId) };
};

/**
 * Utilise validateTeacherBelongsToCampus de validationHelpers.js
 * pour vérifier qu'un enseignant appartient au campus du demandeur.
 */
const assertTeacherOnCampus = async (teacherId, campusId) => {
  const belongs = await validateTeacherBelongsToCampus(teacherId, campusId);
  if (!belongs) {
    const err = new Error('Teacher not found on your campus.');
    err.statusCode = 404;
    throw err;
  }
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** Compute arrival time string (HH:mm) given a start time and a delay in minutes. */
const computeArrivalTime = (sessionStartTime, lateMinutes) => {
  if (!sessionStartTime || !lateMinutes) return undefined;
  const [h, m] = sessionStartTime.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return undefined;
  const total = h * 60 + m + parseInt(lateMinutes, 10);
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

// ─── INIT SESSION ATTENDANCE ─────────────────────────────────────────────────

const initSessionAttendance = asyncHandler(async (req, res) => {
  const { scheduleId } = req.params;
  const {
    teacherId, classId, subjectId, attendanceDate,
    academicYear, semester, sessionStartTime, sessionEndTime,
    status = false, isLate = false, lateMinutes, remarks,
  } = req.body;

  if (!isValidObjectId(scheduleId)) return sendError(res, 400, 'Invalid scheduleId.');
  if (!isValidObjectId(teacherId))  return sendError(res, 400, 'Invalid teacherId.');
  if (!isValidObjectId(classId))    return sendError(res, 400, 'Invalid classId.');
  if (!isValidObjectId(subjectId))  return sendError(res, 400, 'Invalid subjectId.');
  if (!attendanceDate)              return sendError(res, 400, 'attendanceDate is required.');
  if (!academicYear)                return sendError(res, 400, 'academicYear is required.');
  if (!semester)                    return sendError(res, 400, 'semester is required.');

  const campusFilter = buildCampusFilter(req);
  const campusId = campusFilter.schoolCampus
    || (req.body.schoolCampus ? new mongoose.Types.ObjectId(req.body.schoolCampus) : null);

  if (!campusId) return sendError(res, 400, 'schoolCampus is required when initialising as ADMIN/DIRECTOR.');

  if (!isGlobalRole(req.user.role)) {
    await assertTeacherOnCampus(teacherId, req.user.campusId);
  }

  const sessionDate = new Date(attendanceDate);
  if (isNaN(sessionDate)) return sendError(res, 400, 'Invalid attendanceDate format.');

  const dayStart = new Date(sessionDate); dayStart.setHours(0,  0,  0,   0);
  const dayEnd   = new Date(sessionDate); dayEnd.setHours(23, 59, 59, 999);

  const arrivalTime = Boolean(isLate) ? computeArrivalTime(sessionStartTime, lateMinutes) : undefined;

  // Check for existing record
  const existing = await TeacherAttendance.findOne({
    teacher:        new mongoose.Types.ObjectId(teacherId),
    schedule:       new mongoose.Types.ObjectId(scheduleId),
    attendanceDate: { $gte: dayStart, $lte: dayEnd },
  });

  if (existing) {
    if (existing.isLocked) {
      return sendForbidden(res, 'This attendance record is locked. Use justify to modify it.');
    }
    existing.status         = typeof status === 'boolean' ? status : false;
    existing.isLate         = Boolean(isLate);
    if (arrivalTime !== undefined) existing.arrivalTime = arrivalTime;
    if (remarks !== undefined)     existing.remarks     = remarks || null;
    if (sessionStartTime)          existing.sessionStartTime = sessionStartTime;
    if (sessionEndTime)            existing.sessionEndTime   = sessionEndTime;
    existing.lastModifiedBy = req.user.id;
    existing.lastModifiedAt = new Date();
    await existing.save();
    return sendSuccess(res, 200, 'Attendance record updated.', existing);
  }

  const record = await TeacherAttendance.create({
    teacher:          new mongoose.Types.ObjectId(teacherId),
    schedule:         new mongoose.Types.ObjectId(scheduleId),
    schoolCampus:     new mongoose.Types.ObjectId(campusId),
    class:            new mongoose.Types.ObjectId(classId),
    subject:          new mongoose.Types.ObjectId(subjectId),
    attendanceDate:   sessionDate,
    academicYear,
    semester,
    sessionStartTime: sessionStartTime || null,
    sessionEndTime:   sessionEndTime   || null,
    recordedBy:       req.user.id,
    status:           typeof status === 'boolean' ? status : false,
    isLate:           Boolean(isLate),
    arrivalTime:      arrivalTime || null,
    remarks:          remarks || null,
  });

  return sendCreated(res, 'Attendance record created.', record);
});

// ─── GET SESSION ATTENDANCE ──────────────────────────────────────────────────

const getSessionAttendance = asyncHandler(async (req, res) => {
  const { scheduleId } = req.params;
  const { date }       = req.query;

  if (!isValidObjectId(scheduleId)) return sendError(res, 400, 'Invalid scheduleId.');

  const filter = { ...buildCampusFilter(req), schedule: new mongoose.Types.ObjectId(scheduleId) };

  if (date) {
    const d = new Date(date);
    if (isNaN(d)) return sendError(res, 400, 'Invalid date format.');
    const start = new Date(d); start.setHours(0,  0,  0,   0);
    const end   = new Date(d); end.setHours(23, 59, 59, 999);
    filter.attendanceDate = { $gte: start, $lte: end };
  }

  const records = await TeacherAttendance.find(filter)
    .populate('teacher',            'firstName lastName email profileImage employmentType')
    .populate('replacementTeacher', 'firstName lastName email')
    .populate('class',              'className')
    .populate('schedule',           'startTime endTime')
    .sort({ attendanceDate: -1 })
    .lean();

  return sendSuccess(res, 200, 'Session attendance retrieved.', records, { count: records.length });
});

// ─── TOGGLE TEACHER STATUS ───────────────────────────────────────────────────

const toggleTeacherStatus = asyncHandler(async (req, res) => {
  const { attendanceId } = req.params;
  const { status }       = req.body;

  if (!isValidObjectId(attendanceId)) return sendError(res, 400, 'Invalid attendanceId.');
  if (typeof status !== 'boolean')    return sendError(res, 400, "'status' must be a boolean.");

  const record = await TeacherAttendance.findOne({
    _id: new mongoose.Types.ObjectId(attendanceId),
    ...buildCampusFilter(req),
  });

  if (!record)         return sendNotFound(res, 'Attendance record');
  if (record.isLocked) return sendForbidden(res, 'This record is locked. Add a justification instead.');

  await record.toggleStatus(status, req.user.id);

  return sendSuccess(res, 200, 'Teacher attendance updated.', record);
});

// ─── JUSTIFY ABSENCE ─────────────────────────────────────────────────────────

const justifyAbsence = asyncHandler(async (req, res) => {
  const { attendanceId }                         = req.params;
  const { justification, justificationDocument } = req.body;

  if (!isValidObjectId(attendanceId)) return sendError(res, 400, 'Invalid attendanceId.');
  if (!justification?.trim())         return sendError(res, 400, 'justification is required.');

  const record = await TeacherAttendance.findOne({
    _id: new mongoose.Types.ObjectId(attendanceId),
    ...buildCampusFilter(req),
  });

  if (!record)       return sendNotFound(res, 'Attendance record');
  if (record.status) return sendError(res, 400, 'Teacher is marked present — no justification needed.');

  await record.addJustification(justification.trim(), req.user.id, justificationDocument || null);

  return sendSuccess(res, 200, 'Justification added.', record);
});

// ─── ASSIGN REPLACEMENT ──────────────────────────────────────────────────────

const assignReplacement = asyncHandler(async (req, res) => {
  const { attendanceId }                           = req.params;
  const { replacementTeacherId, replacementNotes } = req.body;

  if (!isValidObjectId(attendanceId))         return sendError(res, 400, 'Invalid attendanceId.');
  if (!isValidObjectId(replacementTeacherId)) return sendError(res, 400, 'Invalid replacementTeacherId.');

  if (!isGlobalRole(req.user.role)) {
    await assertTeacherOnCampus(replacementTeacherId, req.user.campusId);
  }

  const record = await TeacherAttendance.findOne({
    _id: new mongoose.Types.ObjectId(attendanceId),
    ...buildCampusFilter(req),
  });

  if (!record)       return sendNotFound(res, 'Attendance record');
  if (record.status) return sendError(res, 400, 'Cannot assign replacement: teacher is already marked present.');

  record.hasReplacement     = true;
  record.replacementTeacher = new mongoose.Types.ObjectId(replacementTeacherId);
  record.replacementNotes   = replacementNotes?.trim() || null;
  record.lastModifiedBy     = req.user.id;
  record.lastModifiedAt     = new Date();

  await record.save();
  await record.populate('replacementTeacher', 'firstName lastName email');

  return sendSuccess(res, 200, 'Replacement teacher assigned.', record);
});

// ─── MARK AS PAID ────────────────────────────────────────────────────────────

const markAsPaid = asyncHandler(async (req, res) => {
  const { attendanceId } = req.params;
  const { paymentRef }   = req.body;

  if (!isValidObjectId(attendanceId)) return sendError(res, 400, 'Invalid attendanceId.');
  if (!paymentRef?.trim())            return sendError(res, 400, 'paymentRef is required.');

  const record = await TeacherAttendance.findOne({
    _id: new mongoose.Types.ObjectId(attendanceId),
    ...buildCampusFilter(req),
  });

  if (!record)        return sendNotFound(res, 'Attendance record');
  if (!record.status) return sendError(res, 400, 'Cannot mark absent session as paid.');
  if (record.isPaid)  return sendError(res, 400, 'This session is already marked as paid.');

  await record.markAsPaid(paymentRef.trim());

  return sendSuccess(res, 200, 'Session marked as paid.', record);
});

// ─── LOCK DAILY ──────────────────────────────────────────────────────────────

const lockDailyAttendance = asyncHandler(async (req, res) => {
  const { date } = req.body;

  const campusFilter = buildCampusFilter(req);
  const campusId     = campusFilter.schoolCampus || null;

  const targetDate = date ? new Date(date) : new Date();
  if (isNaN(targetDate)) return sendError(res, 400, 'Invalid date format.');

  const result = await TeacherAttendance.lockDailyAttendance(targetDate, campusId);

  return sendSuccess(res, 200, `Daily teacher attendance locked for ${result.modifiedCount} record(s).`, {
    modifiedCount: result.modifiedCount,
  });
});

// ─── TEACHER SELF-SERVICE ────────────────────────────────────────────────────

const getMyAttendance = asyncHandler(async (req, res) => {
  const { academicYear, semester, from, to } = req.query;

  if (!academicYear) return sendError(res, 400, 'academicYear is required.');
  if (!semester)     return sendError(res, 400, 'semester is required.');

  // JWT: req.user.id (string) et req.user.campusId (string)
  if (!req.user.campusId) return sendForbidden(res, 'Campus information not found.');
  const filter = {
    teacher:      new mongoose.Types.ObjectId(req.user.id),
    schoolCampus: new mongoose.Types.ObjectId(req.user.campusId),
    academicYear,
    semester,
  };

  if (from || to) {
    filter.attendanceDate = {};
    if (from) filter.attendanceDate.$gte = new Date(from);
    if (to)   filter.attendanceDate.$lte = new Date(to);
  }

  const records = await TeacherAttendance.find(filter)
    .populate('schedule', 'startTime endTime')
    .populate('class',    'className')
    .sort({ attendanceDate: -1 })
    .lean();

  return sendSuccess(res, 200, 'Attendance records retrieved.', records, { count: records.length });
});

const getMyStats = asyncHandler(async (req, res) => {
  const { academicYear, semester, period = 'all' } = req.query;

  if (!academicYear) return sendError(res, 400, 'academicYear is required.');
  if (!semester)     return sendError(res, 400, 'semester is required.');

  // req.user.id = string ID de l'enseignant (JWT)
  const stats = await TeacherAttendance.getTeacherStats(req.user.id, academicYear, semester, period);

  return sendSuccess(res, 200, 'Attendance stats retrieved.', stats);
});

// ─── CAMPUS_MANAGER ANALYTICS ────────────────────────────────────────────────

const getTeacherStats = asyncHandler(async (req, res) => {
  const { teacherId }                              = req.params;
  const { academicYear, semester, period = 'all' } = req.query;

  if (!isValidObjectId(teacherId)) return sendError(res, 400, 'Invalid teacherId.');
  if (!academicYear)               return sendError(res, 400, 'academicYear is required.');
  if (!semester)                   return sendError(res, 400, 'semester is required.');

  if (!isGlobalRole(req.user.role)) {
    await assertTeacherOnCampus(teacherId, req.user.campusId);
  }

  const stats = await TeacherAttendance.getTeacherStats(teacherId, academicYear, semester, period);

  return sendSuccess(res, 200, 'Teacher attendance stats retrieved.', stats);
});

const getCampusStats = asyncHandler(async (req, res) => {
  const { date, period = 'day' } = req.query;

  const campusFilter = buildCampusFilter(req);
  const campusId     = campusFilter.schoolCampus || null;

  if (!campusId && !isGlobalRole(req.user.role)) {
    return sendForbidden(res, 'Campus scope required.');
  }

  const stats = await TeacherAttendance.getCampusStats(campusId, date || null, period);

  return sendSuccess(res, 200, 'Campus attendance stats retrieved.', stats);
});

const getPayrollReport = asyncHandler(async (req, res) => {
  const { month, year, isPaid } = req.query;

  if (!month || !year) return sendError(res, 400, 'month and year are required.');

  const campusFilter = buildCampusFilter(req);

  const matchStage = {
    ...campusFilter,
    month:  parseInt(month, 10),
    year:   parseInt(year,  10),
    status: true,
  };

  if (isPaid === 'true')  matchStage.isPaid = true;
  if (isPaid === 'false') matchStage.isPaid = false;

  const report = await TeacherAttendance.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id:            '$teacher',
        totalSessions:  { $sum: 1 },
        totalMinutes:   { $sum: '$sessionDuration' },
        paidSessions:   { $sum: { $cond: ['$isPaid', 1, 0] } },
        unpaidSessions: { $sum: { $cond: [{ $not: '$isPaid' }, 1, 0] } },
      },
    },
    {
      $lookup: {
        from: 'teachers', localField: '_id', foreignField: '_id', as: 'teacherInfo',
      },
    },
    { $unwind: '$teacherInfo' },
    {
      $project: {
        teacherId:      '$_id',
        firstName:      '$teacherInfo.firstName',
        lastName:       '$teacherInfo.lastName',
        email:          '$teacherInfo.email',
        employmentType: '$teacherInfo.employmentType',
        totalSessions:  1,
        totalHours:     { $round: [{ $divide: ['$totalMinutes', 60] }, 2] },
        paidSessions:   1,
        unpaidSessions: 1,
      },
    },
    { $sort: { lastName: 1 } },
  ]);

  const summary = {
    totalTeachers:     report.length,
    totalHoursAll:     parseFloat(report.reduce((acc, r) => acc + (r.totalHours || 0), 0).toFixed(2)),
    unpaidSessionsAll: report.reduce((acc, r) => acc + r.unpaidSessions, 0),
  };

  return sendSuccess(res, 200, 'Payroll report retrieved.', report, {
    summary, month: parseInt(month, 10), year: parseInt(year, 10),
  });
});

const getCampusOverview = asyncHandler(async (req, res) => {
  const { from, to, teacherId, classId, status, isPaid, page = 1, limit = 50 } = req.query;

  const filter = { ...buildCampusFilter(req) };

  if (from || to) {
    filter.attendanceDate = {};
    if (from) filter.attendanceDate.$gte = new Date(from);
    if (to)   filter.attendanceDate.$lte = new Date(to);
  }

  if (teacherId && isValidObjectId(teacherId)) filter.teacher = new mongoose.Types.ObjectId(teacherId);
  if (classId   && isValidObjectId(classId))   filter.class   = new mongoose.Types.ObjectId(classId);
  if (status === 'true')  filter.status = true;
  if (status === 'false') filter.status = false;
  if (isPaid === 'true')  filter.isPaid = true;
  if (isPaid === 'false') filter.isPaid = false;

  const pageNum  = Math.max(1, parseInt(page,  10) || 1);
  const limitNum = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));

  // summaryFilter omits status so KPIs reflect the full scope (campus/class/date),
  // not just the display-filtered subset — prevents negative absent count and >100% rate.
  const summaryFilter = { ...filter };
  delete summaryFilter.status;

  const [records, total, presentCount] = await Promise.all([
    TeacherAttendance.find(filter)
      .populate('teacher',            'firstName lastName email employmentType')
      .populate('replacementTeacher', 'firstName lastName')
      .populate('schedule',           'startTime endTime')
      .populate('class',              'className')
      .sort({ attendanceDate: -1, sessionStartTime: 1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean(),
    TeacherAttendance.countDocuments(summaryFilter),
    TeacherAttendance.countDocuments({ ...summaryFilter, status: true }),
  ]);

  const summary = {
    total,
    present: presentCount,
    absent:  total - presentCount,
    rate:    total > 0 ? Math.round((presentCount / total) * 100) : 0,
  };

  return sendPaginated(res, 200, 'Campus teacher attendance overview retrieved.', records, {
    total, page: pageNum, limit: limitNum, summary,
  });
});

// ─── PENDING SESSIONS (no attendance record yet) ─────────────────────────────

const getPendingSessions = asyncHandler(async (req, res) => {
  const { teacherId, date } = req.query;

  if (!isValidObjectId(teacherId)) return sendError(res, 400, 'Invalid teacherId.');
  if (!date)                       return sendError(res, 400, 'date is required.');

  const d = new Date(date);
  if (isNaN(d)) return sendError(res, 400, 'Invalid date format.');

  const dayStart = new Date(d); dayStart.setHours(0,  0,  0,   0);
  const dayEnd   = new Date(d); dayEnd.setHours(23, 59, 59, 999);

  const campusFilter = buildCampusFilter(req);

  const sessions = await TeacherSchedule.find({
    'teacher.teacherId': new mongoose.Types.ObjectId(teacherId),
    startTime:   { $gte: dayStart, $lte: dayEnd },
    isDeleted:   false,
    ...campusFilter,
  }).lean();

  if (sessions.length === 0) {
    return sendSuccess(res, 200, 'No sessions found for this teacher on this date.', []);
  }

  const scheduleIds = sessions.map((s) => s._id);

  const existing = await TeacherAttendance.find({
    teacher:        new mongoose.Types.ObjectId(teacherId),
    schedule:       { $in: scheduleIds },
    attendanceDate: { $gte: dayStart, $lte: dayEnd },
  }).select('schedule').lean();

  const recorded = new Set(existing.map((e) => String(e.schedule)));
  const pending  = sessions.filter((s) => !recorded.has(String(s._id)));

  return sendSuccess(res, 200, 'Pending sessions retrieved.', pending);
});

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
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
};