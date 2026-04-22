'use strict';

/**
 * @file studentAttendance.controller.js
 * @description Controller for student attendance management.
 *
 *  Campus isolation est l'invariant central :
 *  JWT payload (foruni) :
 *    req.user.id        → string (ID étudiant/teacher dans le JWT)
 *    req.user.role      → 'ADMIN' | 'DIRECTOR' | 'CAMPUS_MANAGER' | 'TEACHER' | 'STUDENT'
 *    req.user.campusId  → string ObjectId campus (absent pour ADMIN/DIRECTOR)
 *    req.user.classId   → string ObjectId Class (STUDENT uniquement)
 */

const mongoose          = require('mongoose');
const StudentAttendance = require('../../models/student-models/studentAttend.model');
const Student           = require('../../models/student-models/student.model');

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
  validateStudentBelongsToCampus,
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

// ─── INIT SESSION ATTENDANCE ─────────────────────────────────────────────────

const initSessionAttendance = asyncHandler(async (req, res) => {
  const { scheduleId } = req.params;
  const { classId, attendanceDate, academicYear, semester, sessionStartTime, sessionEndTime } = req.body;

  if (!isValidObjectId(scheduleId)) return sendError(res, 400, 'Invalid scheduleId.');
  if (!isValidObjectId(classId))    return sendError(res, 400, 'Invalid classId.');
  if (!attendanceDate)              return sendError(res, 400, 'attendanceDate is required.');
  if (!academicYear)                return sendError(res, 400, 'academicYear is required.');
  if (!semester)                    return sendError(res, 400, 'semester is required.');

  const campusFilter = buildCampusFilter(req);
  const campusId = campusFilter.schoolCampus
    || (req.body.schoolCampus ? new mongoose.Types.ObjectId(req.body.schoolCampus) : null);

  if (!campusId) return sendError(res, 400, 'schoolCampus is required when initialising as ADMIN/DIRECTOR.');

  const sessionDate = new Date(attendanceDate);
  if (isNaN(sessionDate)) return sendError(res, 400, 'Invalid attendanceDate format.');

  const students = await Student.find({
    studentClass: new mongoose.Types.ObjectId(classId),
    schoolCampus: new mongoose.Types.ObjectId(campusId),
    status: 'active',
  }).select('_id').lean();

  if (!students.length) return sendError(res, 404, 'No active students found for this class on this campus.');

  const operations = students.map((s) => ({
    updateOne: {
      filter: {
        student:        s._id,
        schedule:       new mongoose.Types.ObjectId(scheduleId),
        attendanceDate: sessionDate,
      },
      update: {
        $setOnInsert: {
          student:          s._id,
          schedule:         new mongoose.Types.ObjectId(scheduleId),
          class:            new mongoose.Types.ObjectId(classId),
          schoolCampus:     new mongoose.Types.ObjectId(campusId),
          subject: req.body.subjectId ? new mongoose.Types.ObjectId(req.body.subjectId) : undefined,
          attendanceDate:   sessionDate,
          academicYear,
          semester,
          sessionStartTime: sessionStartTime || null,
          sessionEndTime:   sessionEndTime   || null,
          recordedBy:       req.user.id,  // JWT: req.user.id (string, pas _id)
          status:           false,
        },
      },
      upsert: true,
    },
  }));

  const result = await StudentAttendance.bulkWrite(operations, { ordered: false });

  return sendCreated(res, 'Attendance sheet initialised.', {
    upsertedCount: result.upsertedCount,
    matchedCount:  result.matchedCount,
    totalStudents: students.length,
  });
});

// ─── GET SESSION ATTENDANCE ──────────────────────────────────────────────────

const getSessionAttendance = asyncHandler(async (req, res) => {
  const { scheduleId }    = req.params;
  const { date, classId } = req.query;

  if (!isValidObjectId(scheduleId)) return sendError(res, 400, 'Invalid scheduleId.');

  const filter = { ...buildCampusFilter(req), schedule: new mongoose.Types.ObjectId(scheduleId) };

  if (date) {
    const d = new Date(date);
    if (isNaN(d)) return sendError(res, 400, 'Invalid date format.');
    const start = new Date(d); start.setHours(0,  0,  0,   0);
    const end   = new Date(d); end.setHours(23, 59, 59, 999);
    filter.attendanceDate = { $gte: start, $lte: end };
  }

  if (classId && isValidObjectId(classId)) filter.class = new mongoose.Types.ObjectId(classId);

  const records = await StudentAttendance.find(filter)
    .populate('student', 'firstName lastName email profileImage matricule')
    .populate('class',   'className')
    .sort({ 'student.lastName': 1 })
    .lean();

  const summary = {
    total:   records.length,
    present: records.filter((r) =>  r.status).length,
    absent:  records.filter((r) => !r.status).length,
  };

  return sendSuccess(res, 200, 'Session attendance retrieved.', records, { summary });
});

// ─── SUBMIT (LOCK) ATTENDANCE ────────────────────────────────────────────────

const submitAttendance = asyncHandler(async (req, res) => {
  const { scheduleId }              = req.params;
  const { attendanceDate, classId } = req.body;

  if (!isValidObjectId(scheduleId)) return sendError(res, 400, 'Invalid scheduleId.');
  if (!attendanceDate)              return sendError(res, 400, 'attendanceDate is required.');

  const sessionDate = new Date(attendanceDate);
  if (isNaN(sessionDate)) return sendError(res, 400, 'Invalid attendanceDate format.');

  const start = new Date(sessionDate); start.setHours(0,  0,  0,   0);
  const end   = new Date(sessionDate); end.setHours(23, 59, 59, 999);

  const filter = {
    ...buildCampusFilter(req),
    schedule:       new mongoose.Types.ObjectId(scheduleId),
    attendanceDate: { $gte: start, $lte: end },
    isLocked:       false,
  };

  if (classId && isValidObjectId(classId)) filter.class = new mongoose.Types.ObjectId(classId);

  const result = await StudentAttendance.updateMany(filter, {
    $set: {
      isLocked:       true,
      lockedAt:       new Date(),
      lockedByModel:  'Teacher',
      lastModifiedBy: req.user.id,   // JWT: req.user.id
      lastModifiedAt: new Date(),
    },
  });

  return sendSuccess(res, 200, `Attendance submitted and locked for ${result.modifiedCount} student(s).`, {
    modifiedCount: result.modifiedCount,
  });
});

// ─── TOGGLE STUDENT STATUS ───────────────────────────────────────────────────

const toggleStudentStatus = asyncHandler(async (req, res) => {
  const { attendanceId } = req.params;
  const { status }       = req.body;

  if (!isValidObjectId(attendanceId)) return sendError(res, 400, 'Invalid attendanceId.');
  if (typeof status !== 'boolean')    return sendError(res, 400, "'status' must be a boolean.");

  const record = await StudentAttendance.findOne({
    _id: new mongoose.Types.ObjectId(attendanceId),
    ...buildCampusFilter(req),
  });

  if (!record)          return sendNotFound(res, 'Attendance record');
  if (record.isLocked)  return sendForbidden(res, 'This attendance record is locked. Add a justification instead.');

  await record.toggleStatus(status, req.user.id);

  return sendSuccess(res, 200, 'Attendance status updated.', record);
});

// ─── JUSTIFY ABSENCE ─────────────────────────────────────────────────────────

const justifyAbsence = asyncHandler(async (req, res) => {
  const { attendanceId }                         = req.params;
  const { justification, justificationDocument } = req.body;

  if (!isValidObjectId(attendanceId)) return sendError(res, 400, 'Invalid attendanceId.');
  if (!justification?.trim())         return sendError(res, 400, 'justification is required.');

  const record = await StudentAttendance.findOne({
    _id: new mongoose.Types.ObjectId(attendanceId),
    ...buildCampusFilter(req),
  });

  if (!record)       return sendNotFound(res, 'Attendance record');
  if (record.status) return sendError(res, 400, 'Student is marked present — no justification needed.');

  await record.addJustification(justification.trim(), req.user.id, justificationDocument || null);

  return sendSuccess(res, 200, 'Justification added.', record);
});

// ─── LOCK DAILY ──────────────────────────────────────────────────────────────

const lockDailyAttendance = asyncHandler(async (req, res) => {
  const { date } = req.body;

  const campusFilter = buildCampusFilter(req);
  const campusId     = campusFilter.schoolCampus || null;

  const targetDate = date ? new Date(date) : new Date();
  if (isNaN(targetDate)) return sendError(res, 400, 'Invalid date format.');

  const result = await StudentAttendance.lockDailyAttendance(targetDate, campusId);

  return sendSuccess(res, 200, `Daily attendance locked for ${result.modifiedCount} record(s).`, {
    modifiedCount: result.modifiedCount,
  });
});

// ─── STUDENT SELF-SERVICE ────────────────────────────────────────────────────

const getMyAttendance = asyncHandler(async (req, res) => {
  const { academicYear, semester, from, to } = req.query;

  if (!academicYear) return sendError(res, 400, 'academicYear is required.');
  if (!semester)     return sendError(res, 400, 'semester is required.');

  // JWT: req.user.id (string) et req.user.campusId (string)
  const filter = {
    student:      new mongoose.Types.ObjectId(req.user.id),
    schoolCampus: new mongoose.Types.ObjectId(req.user.campusId),
    academicYear,
    semester,
  };

  if (from || to) {
    filter.attendanceDate = {};
    if (from) filter.attendanceDate.$gte = new Date(from);
    if (to)   filter.attendanceDate.$lte = new Date(to);
  }

  const records = await StudentAttendance.find(filter)
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

  // req.user.id = string ID de l'étudiant (JWT)
  const stats = await StudentAttendance.getStudentStats(req.user.id, academicYear, semester, period);

  return sendSuccess(res, 200, 'Attendance stats retrieved.', stats);
});

// ─── ANALYTICS ───────────────────────────────────────────────────────────────

const getStudentStats = asyncHandler(async (req, res) => {
  const { studentId }                              = req.params;
  const { academicYear, semester, period = 'all' } = req.query;

  if (!isValidObjectId(studentId)) return sendError(res, 400, 'Invalid studentId.');
  if (!academicYear)               return sendError(res, 400, 'academicYear is required.');
  if (!semester)                   return sendError(res, 400, 'semester is required.');

  if (!isGlobalRole(req.user.role)) {
    const belongs = await validateStudentBelongsToCampus(studentId, req.user.campusId);
    if (!belongs) return sendNotFound(res, 'Student');
  }

  const stats = await StudentAttendance.getStudentStats(studentId, academicYear, semester, period);

  return sendSuccess(res, 200, 'Student attendance stats retrieved.', stats);
});

const getClassStats = asyncHandler(async (req, res) => {
  const { classId }              = req.params;
  const { date, period = 'day' } = req.query;

  if (!isValidObjectId(classId)) return sendError(res, 400, 'Invalid classId.');

  if (!isGlobalRole(req.user.role)) {
    const Class = mongoose.model('Class');
    const cls = await Class.findOne({
      _id:          new mongoose.Types.ObjectId(classId),
      schoolCampus: new mongoose.Types.ObjectId(req.user.campusId),
    }).lean();
    if (!cls) return sendNotFound(res, 'Class');
  }

  const stats = await StudentAttendance.getClassStats(classId, date || null, period);

  return sendSuccess(res, 200, 'Class attendance stats retrieved.', stats);
});

const getCampusOverview = asyncHandler(async (req, res) => {
  const { from, to, classId, status, page = 1, limit = 50 } = req.query;

  const filter = { ...buildCampusFilter(req) };

  if (from || to) {
    filter.attendanceDate = {};
    if (from) filter.attendanceDate.$gte = new Date(from);
    if (to)   filter.attendanceDate.$lte = new Date(to);
  }

  if (classId && isValidObjectId(classId)) filter.class = new mongoose.Types.ObjectId(classId);
  if (status === 'true')  filter.status = true;
  if (status === 'false') filter.status = false;

  const pageNum  = Math.max(1, parseInt(page,  10) || 1);
  const limitNum = Math.max(1, parseInt(limit, 10) || 50);

  const [records, total] = await Promise.all([
    StudentAttendance.find(filter)
      .populate('student',  'firstName lastName matricule')
      .populate('class',    'className')
      .populate('schedule', 'startTime endTime')
      .sort({ attendanceDate: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean(),
    StudentAttendance.countDocuments(filter),
  ]);

  return sendPaginated(res, 200, 'Campus attendance overview retrieved.', records, {
    total, page: pageNum, limit: limitNum,
  });
});

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  initSessionAttendance,
  getSessionAttendance,
  submitAttendance,
  toggleStudentStatus,
  justifyAbsence,
  lockDailyAttendance,
  getMyAttendance,
  getMyStats,
  getStudentStats,
  getClassStats,
  getCampusOverview,
};