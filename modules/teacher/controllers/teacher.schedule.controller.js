'use strict';

/**
 * @file teacher.schedule.controller.js
 * @description Express controller for teacher-facing schedule operations.
 * 
 *  Expected routes:
 *  ─────────────────────────────────────────────────────────────────
 *  GET    /api/schedules/teacher/me                        → getMyTeacherCalendar
 *  GET    /api/schedules/teacher/:id                       → getTeacherSessionById
 *  PATCH  /api/schedules/teacher/:id/rollcall/open         → openRollCall
 *  PATCH  /api/schedules/teacher/:id/rollcall/submit       → submitRollCall
 *  POST   /api/schedules/teacher/:id/postpone              → requestPostponement
 *  PUT    /api/schedules/teacher/availability              → upsertAvailability
 *  GET    /api/schedules/teacher/availability              → getMyAvailability
 *  GET    /api/schedules/teacher/me/workload               → getMyWorkloadSummary
 *  GET    /api/schedules/teacher/:id/students              → getStudentRoster
 *  GET    /api/schedules/teacher/admin/workload            → getAllTeachersWorkload
 *  GET    /api/schedules/teacher/admin/:teacherId/sessions → getTeacherSessionsAdmin
 *  PATCH  /api/schedules/teacher/admin/postpone/:requestId/review → reviewPostponement
 */

const mongoose        = require('mongoose');
const teacherRepo     = require('../teacher.repository');
const studentService  = require('../../student').service; // student module facade (§3)
const { SCHEDULE_STATUS, SEMESTER } = require('../../../shared/utils/schedule.base');

const {
  sendSuccess,
  sendError,
  sendPaginated,
  asyncHandler,
} = require('../../../shared/utils/response-helpers');

const { isValidObjectId } = require('../../../shared/utils/validation-helpers');

// ─────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────

const parsePositiveInt = (val, fallback) => {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Campus filter based on the JWT role */
const buildCampusFilter = (req) => {
  const { role, campusId } = req.user;
  if (['ADMIN', 'DIRECTOR'].includes(role)) {
    return req.query.campusId ? { schoolCampus: req.query.campusId } : {};
  }
  return { schoolCampus: campusId };
};

/** Computes the ISO week label: "YYYY-WXX" */
const toISOWeekLabel = (date) => {
  const d    = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day  = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum   = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
};

/** Notification stub for the postponement workflow */
const dispatchWorkflowNotification = async (eventType, payload) => {
  try {
    console.info(`[PostponementWorkflow] ${eventType}`, payload);
    // await workflowQueue.add({ eventType, ...payload });
  } catch (err) {
    console.error('[PostponementWorkflow] dispatch failed:', err.message);
  }
};

// ─────────────────────────────────────────────
// TEACHER CALENDAR
// ─────────────────────────────────────────────

/**
 * GET /api/schedules/teacher/me
 * Schedule of the logged-in teacher + weekly workload.
 * Query: from?, to?, sessionType?, includeAllStatuses?
 */
const getMyTeacherCalendar = asyncHandler(async (req, res) => {
  const {
    from,
    to,
    sessionType,
    includeAllStatuses = 'false',
  } = req.query;

  // Cast to ObjectId — req.user.id is a JWT string; MongoDB requires ObjectId for ref fields.
  // Without this cast, 'teacher.teacherId': string never matches ObjectId in the collection.
  if (!isValidObjectId(req.user.id)) {
    return sendError(res, 401, 'Invalid teacher identity in token.');
  }
  const teacherId = new mongoose.Types.ObjectId(req.user.id);

  const now   = new Date();
  const start = from
    ? new Date(from)
    : (() => { const d = new Date(now); d.setDate(d.getDate() - d.getDay()); d.setHours(0,0,0,0); return d; })();
  const end   = to
    ? new Date(to)
    : new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);

  if (isNaN(start) || isNaN(end)) {
    return sendError(res, 400, 'Invalid date range. Use ISO 8601 format.');
  }
  if (end <= start) {
    return sendError(res, 400, "'to' must be after 'from'.");
  }

  const sessions = await teacherRepo.getTeacherCalendar(
    teacherId,
    start,
    end,
    { includeAllStatuses: includeAllStatuses === 'true' }
  );

  const filtered = sessionType
    ? sessions.filter((s) => s.sessionType === sessionType)
    : sessions;

  const weekLabel = toISOWeekLabel(new Date());
  const workload  = await teacherRepo.getWorkloadSummary(teacherId, weekLabel, 'WEEKLY');

  return sendSuccess(res, 200, 'Calendar fetched.', filtered, {
    count:          filtered.length,
    from:           start,
    to:             end,
    weeklyWorkload: workload,
  });
});

/**
 * GET /api/schedules/teacher/:id
 * Details of a session (with room equipment).
 * A teacher can only access their own sessions.
 */
const getTeacherSessionById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid session ID.');

  const session = await teacherRepo.findScheduleSessionLean(id);
  if (!session) return sendError(res, 404, 'Session not found.');

  const isAdmin        = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role);
  const isOwnerTeacher = session.teacher.teacherId.toString() === req.user.id;

  if (!isAdmin && !isOwnerTeacher) {
    return sendError(res, 403, 'Access denied.');
  }

  return sendSuccess(res, 200, 'Session fetched.', session);
});

// ─────────────────────────────────────────────
// ROLL-CALL
// ─────────────────────────────────────────────

/**
 * PATCH /api/schedules/teacher/:id/rollcall/open
 * Opens the roll-call for a session.
 */
const openRollCall = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid session ID.');

  const session = await teacherRepo.findScheduleSessionForWrite(id);
  if (!session) return sendError(res, 404, 'Session not found.');

  const isAdmin        = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role);
  const isOwnerTeacher = session.teacher.teacherId.toString() === req.user.id;
  if (!isAdmin && !isOwnerTeacher) {
    return sendError(res, 403, 'Only the assigned teacher or an admin can open roll-call.');
  }

  if (session.rollCall.submitted) {
    return sendError(res, 400, 'Attendance has already been submitted for this session.');
  }
  if (session.rollCall.opened) {
    return sendError(res, 400, 'Roll-call is already open.');
  }

  // Allow opening 30 min before the session start time
  const BUFFER_MS = 30 * 60 * 1000;
  if (new Date() < new Date(session.startTime.getTime() - BUFFER_MS)) {
    return sendError(
      res,
      400,
      'Roll-call can only be opened close to the session start time (30 min before).'
    );
  }

  session.rollCall.opened   = true;
  session.rollCall.openedAt = new Date();
  await teacherRepo.saveScheduleDoc(session);

  return sendSuccess(res, 200, 'Roll-call opened.', { rollCall: session.rollCall });
});

/**
 * PATCH /api/schedules/teacher/:id/rollcall/submit
 * Locks the roll-call with the counts.
 * Body: { present, absent, late }
 */
const submitRollCall = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { present = 0, absent = 0, late = 0 } = req.body;

  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid session ID.');

  if ([present, absent, late].some((v) => v < 0 || !Number.isFinite(Number(v)))) {
    return sendError(res, 400, 'Attendance counts must be non-negative numbers.');
  }

  const session = await teacherRepo.findScheduleSessionForWrite(id);
  if (!session) return sendError(res, 404, 'Session not found.');

  const isAdmin        = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role);
  const isOwnerTeacher = session.teacher.teacherId.toString() === req.user.id;
  if (!isAdmin && !isOwnerTeacher) {
    return sendError(res, 403, 'Only the assigned teacher or an admin can submit roll-call.');
  }

  if (!session.rollCall.opened) {
    return sendError(res, 400, 'Roll-call has not been opened yet.');
  }
  if (session.rollCall.submitted) {
    return sendError(res, 400, 'Attendance has already been submitted and locked.');
  }

  session.rollCall.submitted    = true;
  session.rollCall.submittedAt  = new Date();
  session.rollCall.totalPresent = Number(present);
  session.rollCall.totalAbsent  = Number(absent);
  session.rollCall.totalLate    = Number(late);
  await teacherRepo.saveScheduleDoc(session);

  // Sync the summary into StudentSchedule (fire-and-forget)
  if (session.studentScheduleRef) {
    const total = Number(present) + Number(absent) + Number(late);
    studentService.updateAttendanceSummary(session.studentScheduleRef, {
      'attendance.present':  Number(present),
      'attendance.absent':   Number(absent),
      'attendance.late':     Number(late),
      'attendance.closed':   true,
      'attendance.closedAt': new Date(),
      'attendance.rate':     total > 0
        ? Math.round((Number(present) / total) * 100)
        : null,
    }).catch((err) =>
      console.error('[RollCall] failed to sync StudentSchedule attendance:', err.message)
    );
  }

  return sendSuccess(res, 200, 'Attendance submitted and locked.', { rollCall: session.rollCall });
});

// ─────────────────────────────────────────────
// POSTPONEMENT WORKFLOW
// ─────────────────────────────────────────────

/**
 * POST /api/schedules/teacher/:id/postpone
 * The teacher submits a postponement request.
 * Body: { reason (min 10 chars), proposedStart?, proposedEnd? }
 */
const requestPostponement = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { reason, proposedStart, proposedEnd } = req.body;

  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid session ID.');
  if (!reason || reason.trim().length < 10) {
    return sendError(res, 400, 'A reason with at least 10 characters is required.');
  }

  const session = await teacherRepo.findScheduleSessionForWrite(id);
  if (!session) return sendError(res, 404, 'Session not found.');

  const isOwnerTeacher = session.teacher.teacherId.toString() === req.user.id;
  if (!isOwnerTeacher) {
    return sendError(res, 403, 'Only the assigned teacher can request a postponement.');
  }
  if (session.status === SCHEDULE_STATUS.CANCELLED) {
    return sendError(res, 400, 'Cannot request postponement for a cancelled session.');
  }

  const hasPending = session.postponementRequests.some((r) => r.status === 'PENDING');
  if (hasPending) {
    return sendError(res, 400, 'A postponement request is already pending review.');
  }

  session.postponementRequests.push({
    requestedBy:   req.user.id,
    reason:        reason.trim(),
    proposedStart: proposedStart ? new Date(proposedStart) : undefined,
    proposedEnd:   proposedEnd   ? new Date(proposedEnd)   : undefined,
    status:        'PENDING',
  });
  await teacherRepo.saveScheduleDoc(session);

  await dispatchWorkflowNotification('POSTPONEMENT_REQUESTED', {
    sessionId:   session._id,
    reference:   session.reference,
    teacherName: `${session.teacher.firstName} ${session.teacher.lastName}`,
    reason,
  });

  const savedRequest =
    session.postponementRequests[session.postponementRequests.length - 1];

  return sendSuccess(
    res,
    201,
    'Postponement request submitted. Awaiting Campus Manager review.',
    savedRequest
  );
});

/**
 * PATCH /api/schedules/teacher/admin/postpone/:requestId/review
 * The Campus Manager approves or rejects a postponement request.
 * Body: { status: 'APPROVED' | 'REJECTED', reviewNote? }
 */
const reviewPostponement = asyncHandler(async (req, res) => {
  const { requestId } = req.params;
  const { status, reviewNote = '' } = req.body;

  if (!isValidObjectId(requestId)) return sendError(res, 400, 'Invalid request ID.');
  if (!['APPROVED', 'REJECTED'].includes(status)) {
    return sendError(res, 400, "status must be 'APPROVED' or 'REJECTED'.");
  }

  const session = await teacherRepo.findScheduleByPostponementRequest(requestId);
  if (!session) return sendError(res, 404, 'Postponement request not found.');

  const request = session.postponementRequests.id(requestId);
  if (request.status !== 'PENDING') {
    return sendError(res, 400, 'This request has already been reviewed.');
  }

  request.status     = status;
  request.reviewedBy = req.user.id;
  request.reviewedAt = new Date();
  request.reviewNote = reviewNote.trim();

  if (status === 'APPROVED') {
    session.status = SCHEDULE_STATUS.POSTPONED;
    if (request.proposedStart && request.proposedEnd) {
      session.originalStart = session.startTime;
      session.startTime     = request.proposedStart;
      session.endTime       = request.proposedEnd;
    }
  }

  session.lastModifiedBy = req.user.id;
  await teacherRepo.saveScheduleDoc(session);

  await dispatchWorkflowNotification(
    status === 'APPROVED' ? 'POSTPONEMENT_APPROVED' : 'POSTPONEMENT_REJECTED',
    {
      sessionId:  session._id,
      reference:  session.reference,
      reviewNote,
      teacherId:  session.teacher.teacherId,
    }
  );

  return sendSuccess(
    res,
    200,
    `Postponement request ${status.toLowerCase()}.`,
    request
  );
});

/**
 * GET /api/schedules/teacher/admin/postponements
 * Lists all postponement requests filtered by status for the campus.
 * Query: status (PENDING|APPROVED|REJECTED, default PENDING), page, limit
 */
const getPendingPostponements = asyncHandler(async (req, res) => {
  const {
    status = 'PENDING',
    page   = 1,
    limit  = 50,
  } = req.query;

  const VALID_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'];
  if (!VALID_STATUSES.includes(status)) {
    return sendError(res, 400, `status must be one of ${VALID_STATUSES.join(', ')}.`);
  }

  const pageNum  = parsePositiveInt(page, 1);
  const limitNum = parsePositiveInt(limit, 50);
  const skip     = (pageNum - 1) * limitNum;

  const campusFilter = buildCampusFilter(req);

  const sessions = await teacherRepo.listSchedulesWithPostponements(campusFilter, status);

  const rows = [];
  for (const session of sessions) {
    for (const preq of session.postponementRequests) {
      if (preq.status !== status) continue;
      rows.push({
        requestId:     preq._id,
        sessionId:     session._id,
        reference:     session.reference,
        teacher: {
          id:        session.teacher?.teacherId,
          firstName: session.teacher?.firstName,
          lastName:  session.teacher?.lastName,
          email:     session.teacher?.email,
        },
        subject:       session.subject?.name,
        sessionStart:  session.startTime,
        sessionEnd:    session.endTime,
        reason:        preq.reason,
        proposedStart: preq.proposedStart,
        proposedEnd:   preq.proposedEnd,
        requestedAt:   preq._id?.toString ? new Date(parseInt(preq._id.toString().substring(0, 8), 16) * 1000) : null,
        status:        preq.status,
        reviewNote:    preq.reviewNote,
        reviewedAt:    preq.reviewedAt,
      });
    }
  }

  rows.sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));

  const total = rows.length;
  const paged = rows.slice(skip, skip + limitNum);

  return sendPaginated(res, 200, 'Postponement requests fetched.', paged, {
    total,
    page:  pageNum,
    limit: limitNum,
  });
});

// ─────────────────────────────────────────────
// AVAILABILITY
// ─────────────────────────────────────────────

/**
 * PUT /api/schedules/teacher/availability
 * Submits or replaces all availability preferences (idempotent).
 * Body: { slots: AvailabilitySlot[], academicYear?, semester? }
 */
const upsertAvailability = asyncHandler(async (req, res) => {
  const { slots = [], academicYear, semester } = req.body;
  // Cast to ObjectId — req.user.id is a string from the JWT payload
  const teacherId = new mongoose.Types.ObjectId(req.user.id);
  const campusId  = req.user.campusId;

  if (!Array.isArray(slots)) {
    return sendError(res, 400, "'slots' must be an array.");
  }

  const VALID_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  for (const slot of slots) {
    if (!VALID_DAYS.includes(slot.day)) {
      return sendError(
        res,
        400,
        `Invalid day "${slot.day}". Must be one of ${VALID_DAYS.join(', ')}.`
      );
    }
    if (slot.startHour == null || slot.endHour == null || slot.endHour <= slot.startHour) {
      return sendError(res, 400, 'Each slot must have valid startHour < endHour (0–24).');
    }
  }

  // Availability profile document: no studentScheduleRef and no sessionType
  let profileDoc = await teacherRepo.findAvailabilityProfileForWrite(teacherId);

  const now = new Date();
  const defaultYear = `${now.getFullYear()}-${now.getFullYear() + 1}`;

  if (!profileDoc) {
    profileDoc = teacherRepo.newTeacherScheduleDoc({
      teacher:      { teacherId },
      schoolCampus: campusId,
      academicYear: academicYear || defaultYear,
      semester:     semester || SEMESTER.S1,
      startTime:    now,
      endTime:      now,
    });
  }

  profileDoc.availabilitySlots = slots;
  profileDoc.lastModifiedBy    = teacherId;
  await teacherRepo.saveScheduleDoc(profileDoc);

  return sendSuccess(res, 200, 'Availability preferences saved.', profileDoc.availabilitySlots);
});

/**
 * GET /api/schedules/teacher/availability
 * Returns the availability slots of the logged-in teacher.
 */
const getMyAvailability = asyncHandler(async (req, res) => {
  // Cast to ObjectId — req.user.id is a string from the JWT payload
  const teacherId = new mongoose.Types.ObjectId(req.user.id);

  const profileDoc = await teacherRepo.findAvailabilityProfile(teacherId);

  return sendSuccess(
    res,
    200,
    profileDoc ? 'Availability fetched.' : 'No availability set yet.',
    profileDoc?.availabilitySlots ?? []
  );
});

// ─────────────────────────────────────────────
// WORKLOAD
// ─────────────────────────────────────────────

/**
 * GET /api/schedules/teacher/me/workload
 * Workload summary of the logged-in teacher.
 * Query: periodType (WEEKLY|MONTHLY), periodLabel?
 */
const getMyWorkloadSummary = asyncHandler(async (req, res) => {
  // Cast to ObjectId — req.user.id is a string from the JWT payload
  const teacherId = new mongoose.Types.ObjectId(req.user.id);
  const { periodType = 'MONTHLY', periodLabel } = req.query;

  if (!['WEEKLY', 'MONTHLY'].includes(periodType)) {
    return sendError(res, 400, "periodType must be 'WEEKLY' or 'MONTHLY'.");
  }

  const now    = new Date();
  const label  = periodLabel || (
    periodType === 'WEEKLY'
      ? toISOWeekLabel(now)
      : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  );

  const summary = await teacherRepo.getWorkloadSummary(teacherId, label, periodType);

  return sendSuccess(res, 200, 'Workload summary fetched.', { periodType, periodLabel: label, ...summary });
});

/**
 * GET /api/schedules/teacher/:id/students
 * List of students for a session (for the roll-call interface).
 * Returns the classes and expected headcount from the mirror StudentSchedule.
 */
const getStudentRoster = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid session ID.');

  const session = await teacherRepo.findScheduleSessionLean(id);
  if (!session) return sendError(res, 404, 'Session not found.');

  const isAdmin        = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role);
  const isOwnerTeacher = session.teacher.teacherId.toString() === req.user.id;
  if (!isAdmin && !isOwnerTeacher) return sendError(res, 403, 'Access denied.');

  if (!session.studentScheduleRef) {
    return sendError(res, 404, 'No linked student schedule found for this session.');
  }

  const studentSession = await studentService.getSessionRoster(session.studentScheduleRef);

  if (!studentSession) return sendError(res, 404, 'Linked student schedule not found.');

  return sendSuccess(res, 200, 'Student roster fetched.', {
    classes:           studentSession.classes,
    expectedAttendees: studentSession.expectedAttendees,
    rollCallStatus:    session.rollCall,
  });
});

// ─────────────────────────────────────────────
// ADMIN ENDPOINTS
// ─────────────────────────────────────────────

/**
 * GET /api/schedules/teacher/admin/:teacherId/sessions
 * All sessions of a teacher (admin view).
 * Query: from, to, status?, page, limit, includeAllStatuses
 */
const getTeacherSessionsAdmin = asyncHandler(async (req, res) => {
  const { teacherId } = req.params;
  const {
    from,
    to,
    status,
    page  = 1,
    limit = 50,
    includeAllStatuses = 'false',
  } = req.query;

  if (!isValidObjectId(teacherId)) {
    return sendError(res, 400, 'Invalid teacher ID.');
  }

  const now   = new Date();
  const start = from ? new Date(from) : new Date(now.getFullYear(), now.getMonth(), 1);
  const end   = to   ? new Date(to)   : new Date(now.getFullYear(), now.getMonth() + 1, 0);

  const filter = {
    'teacher.teacherId': new mongoose.Types.ObjectId(teacherId),
    startTime:           { $gte: start },
    endTime:             { $lte: end },
    isDeleted:           false,
    sessionType:         { $exists: true },
    ...buildCampusFilter(req),
  };

  if (includeAllStatuses !== 'true') {
    filter.status = status
      ? status
      : { $in: [SCHEDULE_STATUS.DRAFT, SCHEDULE_STATUS.PUBLISHED, SCHEDULE_STATUS.POSTPONED] };
  }

  const pageNum  = parsePositiveInt(page, 1);
  const limitNum = parsePositiveInt(limit, 50);
  const skip     = (pageNum - 1) * limitNum;

  const { docs: sessions, total } = await teacherRepo.paginateTeacherSessions(
    filter,
    { skip, limit: limitNum }
  );

  return sendPaginated(
    res,
    200,
    'Teacher sessions fetched.',
    sessions,
    { total, page: pageNum, limit: limitNum }
  );
});

/**
 * GET /api/schedules/teacher/admin/workload
 * Aggregated workload report for all teachers (payroll).
 * Query: periodType, periodLabel, campusId?, department?
 */
const getAllTeachersWorkload = asyncHandler(async (req, res) => {
  const { periodType = 'MONTHLY', periodLabel, department } = req.query;

  if (!['WEEKLY', 'MONTHLY'].includes(periodType)) {
    return sendError(res, 400, "periodType must be 'WEEKLY' or 'MONTHLY'.");
  }

  const now   = new Date();
  const label = periodLabel ||
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const matchStage = {
    'workloadSnapshots.periodLabel': label,
    'workloadSnapshots.periodType':  periodType,
    isDeleted: false,
    ...buildCampusFilter(req),
  };

  if (department) matchStage['subject.department'] = department;

  const report = await teacherRepo.aggregateAllTeachersWorkload(matchStage);

  return sendSuccess(res, 200, 'Workload report fetched.', report, {
    periodType,
    periodLabel:   label,
    totalTeachers: report.length,
  });
});

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  // Teacher
  getMyTeacherCalendar,
  getTeacherSessionById,
  openRollCall,
  submitRollCall,
  requestPostponement,
  upsertAvailability,
  getMyAvailability,
  getMyWorkloadSummary,
  getStudentRoster,
  // Admin / Campus Manager
  getTeacherSessionsAdmin,
  reviewPostponement,
  getAllTeachersWorkload,
  getPendingPostponements,
};