'use strict';

/**
 * @file student.attendance.controller.js
 * @description Controller for student attendance management.
 *
 *  Campus isolation est l'invariant central :
 *  JWT payload (foruni) :
 *    req.user.id        → string (ID étudiant/teacher dans le JWT)
 *    req.user.role      → 'ADMIN' | 'DIRECTOR' | 'CAMPUS_MANAGER' | 'TEACHER' | 'STUDENT'
 *    req.user.campusId  → string ObjectId campus (absent pour ADMIN/DIRECTOR)
 *    req.user.classId   → string ObjectId Class (STUDENT uniquement)
 */

const mongoose     = require('mongoose');
const studentRepo  = require('../student.repository');
const classService = require('../../class').service; // class module facade (§3)

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
const { validateStudentBelongsToCampus } = require('../student.service');

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

  const students = await studentRepo.findActiveStudentsForAttendance(classId, campusId);

  if (!students.length) return sendError(res, 404, 'No active students found for this class on this campus.');

  const { upsertedCount, matchedCount } = await studentRepo.initSessionAttendanceRecords({
    students,
    scheduleId,
    classId,
    campusId,
    subjectId:        req.body.subjectId,
    attendanceDate:   sessionDate,
    academicYear,
    semester,
    sessionStartTime,
    sessionEndTime,
    recordedBy:       req.user.id,  // JWT: req.user.id (string, pas _id)
  });

  return sendCreated(res, 'Attendance sheet initialised.', {
    upsertedCount,
    matchedCount,
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

  const records = await studentRepo.findSessionAttendanceRecords(filter);

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

  const { modifiedCount } = await studentRepo.lockSessionAttendance(filter, req.user.id);

  return sendSuccess(res, 200, `Attendance submitted and locked for ${modifiedCount} student(s).`, {
    modifiedCount,
  });
});

// ─── TOGGLE STUDENT STATUS ───────────────────────────────────────────────────

const toggleStudentStatus = asyncHandler(async (req, res) => {
  const { attendanceId } = req.params;
  const { status }       = req.body;

  if (!isValidObjectId(attendanceId)) return sendError(res, 400, 'Invalid attendanceId.');
  if (typeof status !== 'boolean')    return sendError(res, 400, "'status' must be a boolean.");

  const record = await studentRepo.findAttendanceRecordScoped(attendanceId, buildCampusFilter(req));

  if (!record)          return sendNotFound(res, 'Attendance record');
  if (record.isLocked)  return sendForbidden(res, 'This attendance record is locked. Add a justification instead.');

  await studentRepo.toggleAttendanceStatus(record, status, req.user.id);

  return sendSuccess(res, 200, 'Attendance status updated.', record);
});

// ─── JUSTIFY ABSENCE ─────────────────────────────────────────────────────────

const justifyAbsence = asyncHandler(async (req, res) => {
  const { attendanceId }                         = req.params;
  const { justification, justificationDocument } = req.body;

  if (!isValidObjectId(attendanceId)) return sendError(res, 400, 'Invalid attendanceId.');
  if (!justification?.trim())         return sendError(res, 400, 'justification is required.');

  const record = await studentRepo.findAttendanceRecordScoped(attendanceId, buildCampusFilter(req));

  if (!record)       return sendNotFound(res, 'Attendance record');
  if (record.status) return sendError(res, 400, 'Student is marked present — no justification needed.');

  await studentRepo.addAttendanceJustification(record, justification.trim(), req.user.id, justificationDocument || null);

  return sendSuccess(res, 200, 'Justification added.', record);
});

// ─── LOCK DAILY ──────────────────────────────────────────────────────────────

const lockDailyAttendance = asyncHandler(async (req, res) => {
  const { date } = req.body;

  const campusFilter = buildCampusFilter(req);
  const campusId     = campusFilter.schoolCampus || null;

  const targetDate = date ? new Date(date) : new Date();
  if (isNaN(targetDate)) return sendError(res, 400, 'Invalid date format.');

  const result = await studentRepo.lockDailyAttendance(targetDate, campusId);

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

  const records = await studentRepo.findStudentAttendanceRecords(filter);

  return sendSuccess(res, 200, 'Attendance records retrieved.', records, { count: records.length });
});

const getMyStats = asyncHandler(async (req, res) => {
  const { academicYear, semester, period = 'all' } = req.query;

  if (!academicYear) return sendError(res, 400, 'academicYear is required.');
  if (!semester)     return sendError(res, 400, 'semester is required.');

  // req.user.id = student string ID (JWT)
  const stats = await studentRepo.getStudentStats(req.user.id, academicYear, semester, period);

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

  const stats = await studentRepo.getStudentStats(studentId, academicYear, semester, period);

  return sendSuccess(res, 200, 'Student attendance stats retrieved.', stats);
});

const getClassStats = asyncHandler(async (req, res) => {
  const { classId }              = req.params;
  const { date, period = 'day' } = req.query;

  if (!isValidObjectId(classId)) return sendError(res, 400, 'Invalid classId.');

  if (!isGlobalRole(req.user.role)) {
    const belongs = await classService.classExistsInCampus(classId, req.user.campusId);
    if (!belongs) return sendNotFound(res, 'Class');
  }

  const stats = await studentRepo.getClassStats(classId, date || null, period);

  return sendSuccess(res, 200, 'Class attendance stats retrieved.', stats);
});

const getCampusOverview = asyncHandler(async (req, res) => {
  const { from, to, classId, studentId, status, page = 1, limit = 50 } = req.query;

  const filter = { ...buildCampusFilter(req) };

  if (from || to) {
    filter.attendanceDate = {};
    if (from) filter.attendanceDate.$gte = new Date(from);
    if (to)   filter.attendanceDate.$lte = new Date(to);
  }

  if (classId   && isValidObjectId(classId))   filter.class   = new mongoose.Types.ObjectId(classId);
  if (studentId && isValidObjectId(studentId)) filter.student = new mongoose.Types.ObjectId(studentId);
  if (status === 'true')  filter.status = true;
  if (status === 'false') filter.status = false;

  const pageNum  = Math.max(1, parseInt(page,  10) || 1);
  const limitNum = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));

  // summaryFilter omits status so KPIs reflect the full scope (campus/class/date),
  // not just the display-filtered subset — prevents negative absent count and >100% rate.
  const summaryFilter = { ...filter };
  delete summaryFilter.status;

  const { records, total, presentCount } = await studentRepo.attendanceCampusOverview(
    filter,
    summaryFilter,
    { skip: (pageNum - 1) * limitNum, limit: limitNum },
  );

  const summary = {
    total,
    present: presentCount,
    absent:  total - presentCount,
    rate:    total > 0 ? Math.round((presentCount / total) * 100) : 0,
  };

  return sendPaginated(res, 200, 'Campus attendance overview retrieved.', records, {
    total, page: pageNum, limit: limitNum, summary,
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