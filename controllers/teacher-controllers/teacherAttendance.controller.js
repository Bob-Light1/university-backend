'use strict';

/**
 * @file teacherAttendance.controller.js
 * @description Controller for teacher attendance management.
 *
 *  JWT payload (foruni) :
 *    req.user.id        → string (ID teacher dans le JWT)
 *    req.user.role      → 'ADMIN' | 'DIRECTOR' | 'CAMPUS_MANAGER' | 'TEACHER' | 'STUDENT'
 *    req.user.campusId  → string ObjectId campus (absent pour ADMIN/DIRECTOR)
 */

const mongoose          = require('mongoose');
const TeacherAttendance = require('../../models/teacher-models/teacherAttend.model');

const {
  asyncHandler,
  sendSuccess,
  sendError,
  sendCreated,
  sendPaginated,
  sendNotFound,
  sendForbidden,
} = require('../../utils/responseHelpers');

const {
  isValidObjectId,
  validateTeacherBelongsToCampus,
} = require('../../utils/validationHelpers');

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

// ─── INIT SESSION ATTENDANCE ─────────────────────────────────────────────────

const initSessionAttendance = asyncHandler(async (req, res) => {
  const { scheduleId } = req.params;
  const {
    teacherId, classId, subjectId, attendanceDate,
    academicYear, semester, sessionStartTime, sessionEndTime,
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

  const record = await TeacherAttendance.findOneAndUpdate(
    {
      teacher:        new mongoose.Types.ObjectId(teacherId),
      schedule:       new mongoose.Types.ObjectId(scheduleId),
      attendanceDate: { $gte: dayStart, $lte: dayEnd },
    },
    {
      $setOnInsert: {
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
        recordedBy:       req.user.id,  // JWT: req.user.id (string)
        status:           false,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const isNew = record.createdAt && (Date.now() - new Date(record.createdAt).getTime()) < 3000;

  return isNew
    ? sendCreated(res, 'Attendance record created.', record)
    : sendSuccess(res, 200, 'Attendance record already exists.', record);
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
  const { from, to, teacherId, status, isPaid, page = 1, limit = 50 } = req.query;

  const filter = { ...buildCampusFilter(req) };

  if (from || to) {
    filter.attendanceDate = {};
    if (from) filter.attendanceDate.$gte = new Date(from);
    if (to)   filter.attendanceDate.$lte = new Date(to);
  }

  if (teacherId && isValidObjectId(teacherId)) filter.teacher = new mongoose.Types.ObjectId(teacherId);
  if (status === 'true')  filter.status = true;
  if (status === 'false') filter.status = false;
  if (isPaid === 'true')  filter.isPaid = true;
  if (isPaid === 'false') filter.isPaid = false;

  const pageNum  = Math.max(1, parseInt(page,  10) || 1);
  const limitNum = Math.max(1, parseInt(limit, 10) || 50);

  const [records, total] = await Promise.all([
    TeacherAttendance.find(filter)
      .populate('teacher',            'firstName lastName email employmentType')
      .populate('replacementTeacher', 'firstName lastName')
      .populate('schedule',           'startTime endTime')
      .populate('class',              'className')
      .sort({ attendanceDate: -1, sessionStartTime: 1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean(),
    TeacherAttendance.countDocuments(filter),
  ]);

  return sendPaginated(res, 200, 'Campus teacher attendance overview retrieved.', records, {
    total, page: pageNum, limit: limitNum,
  });
});

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  initSessionAttendance,
  getSessionAttendance,
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