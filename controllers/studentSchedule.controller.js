'use strict';

/**
 * @file studentSchedule.controller.js
 * @description Express controller for student-facing schedule operations.
 *
 * Campus isolation contract (enforced in every write operation):
 *   • CAMPUS_MANAGER / TEACHER / STUDENT → locked to req.user.campusId
 *   • ADMIN / DIRECTOR                   → cross-campus, campusId from body/query
 *
 * Key change vs original:
 *   createSession and updateSession now call resolveSessionParticipants()
 *   to fetch and validate subject, teacher and classes from the DB before saving.
 *   The frontend sends flat IDs (subjectId, teacherId, classIds[]).
 *   The controller is responsible for assembling the denormalised nested objects
 *   expected by the StudentSchedule mongoose model.
 *
 * Routes (registered in studentSchedule.router.js):
 *   GET    /api/schedules/student/me                          → getMyCalendar
 *   GET    /api/schedules/student/export/ics                  → exportCalendarICS
 *   GET    /api/schedules/student/:id                         → getSessionById
 *   GET    /api/schedules/student/:id/attendance              → getAttendanceForSession
 *   POST   /api/schedules/student/admin/sessions              → createSession
 *   PUT    /api/schedules/student/admin/sessions/:id          → updateSession
 *   PATCH  /api/schedules/student/admin/sessions/:id/publish  → publishSession
 *   PATCH  /api/schedules/student/admin/sessions/:id/cancel   → cancelSession
 *   DELETE /api/schedules/student/admin/sessions/:id          → softDeleteSession
 *   GET    /api/schedules/student/admin/overview              → getCampusOverview
 *   GET    /api/schedules/student/admin/room-occupancy        → getRoomOccupancyReport
 */

const mongoose        = require('mongoose');
const StudentSchedule = require('../models/studentSchedule.model');
const TeacherSchedule = require('../models/teacherSchedule.model');
const Student         = require('../models/student.model');

const { SCHEDULE_STATUS, SESSION_TYPE, SEMESTER } = require('../utils/schedule.base');

const {
  sendSuccess,
  sendError,
  sendPaginated,
  asyncHandler,
} = require('../utils/responseHelpers');

const { isValidObjectId } = require('../utils/validationHelpers');

// Shared helper: resolves subjectId / teacherId / classIds → denormalised objects
const { resolveSessionParticipants } = require('../utils/scheduleHelpers');

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const parsePositiveInt = (val, fallback) => {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Returns the Mongoose campus filter appropriate for the requester's role.
 * ADMIN / DIRECTOR can optionally pass ?campusId= to narrow results.
 */
const buildCampusFilter = (req) => {
  const { role, campusId } = req.user;
  if (['ADMIN', 'DIRECTOR'].includes(role)) {
    return req.query.campusId ? { schoolCampus: req.query.campusId } : {};
  }
  return { schoolCampus: campusId };
};

/**
 * Resolves the effective campusId for write operations:
 *   ADMIN/DIRECTOR may pass campusId in the request body.
 *   All other roles are locked to their JWT campusId.
 */
const resolveWriteCampus = (req, campusFromBody) => {
  const { role, campusId: userCampusId } = req.user;
  return ['ADMIN', 'DIRECTOR'].includes(role)
    ? (campusFromBody || userCampusId)
    : userCampusId;
};

/**
 * Stub notification dispatcher (wire to Bull / RabbitMQ / SNS in production).
 */
const dispatchNotification = async (eventType, session) => {
  try {
    console.info(`[ScheduleNotification] ${eventType} → ${session.reference}`);
  } catch (err) {
    console.error('[ScheduleNotification] dispatch failed:', err.message);
  }
};

/**
 * Resolves the classId for the connected student from the database.
 * The JWT payload does not carry classId (it only holds id, role, campusId).
 * This lookup is campus-isolated: the returned classId is always validated
 * against req.user.campusId to prevent cross-campus data leaks.
 *
 * @param   {string} userId   - req.user.id (student's _id in JWT)
 * @param   {string} campusId - req.user.campusId (campus lock from JWT)
 * @returns {string|null}     - studentClass ObjectId as string, or null
 */
const resolveStudentClass = async (userId, campusId) => {
  const student = await Student.findOne({
    _id:          userId,
    schoolCampus: campusId,  // campus-isolation guard
    status:       { $ne: 'archived' },
  })
    .select('studentClass')
    .lean();

  return student?.studentClass?.toString() ?? null;
};

/**
 * Synchronises (upserts) the TeacherSchedule mirror document for a given
 * StudentSchedule session.
 *
 * Design rationale:
 *   • The two collections (student_schedules / teacher_schedules) share the
 *     same real-world session but serve different audiences.
 *   • A TeacherSchedule document is the authoritative source for the teacher's
 *     calendar (GET /schedules/teacher/me).
 *   • It must be created/updated whenever a StudentSchedule is created or mutated
 *     so both views stay consistent.
 *   • The link between the two is maintained via:
 *       TeacherSchedule.studentScheduleRef → StudentSchedule._id
 *
 * @param {Object} ss      - Lean or Mongoose StudentSchedule document
 * @param {string} actorId - req.user.id of the person triggering the change
 */
const syncTeacherSchedule = async (ss, actorId) => {
  try {
    const payload = {
      // Cross-reference back to the StudentSchedule
      studentScheduleRef: ss._id,
      schoolCampus:       ss.schoolCampus,
      status:             ss.status,
      academicYear:       ss.academicYear,
      semester:           ss.semester,
      sessionType:        ss.sessionType,
      startTime:          ss.startTime,
      endTime:            ss.endTime,
      durationMinutes:    ss.durationMinutes,
      isVirtual:          ss.isVirtual,
      room:               ss.room,
      virtualMeeting:     ss.virtualMeeting,
      subject:            ss.subject,
      teacher:            ss.teacher,
      classes:            ss.classes,
      recurrence:         ss.recurrence,
      isDeleted:          ss.isDeleted,
      deletedAt:          ss.deletedAt,
      publishedAt:        ss.publishedAt,
      publishedBy:        ss.publishedBy,
      lastModifiedBy:     actorId,
    };

    await TeacherSchedule.findOneAndUpdate(
      { studentScheduleRef: ss._id },   // idempotent: keyed on the StudentSchedule id
      { $set: payload },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    // Non-fatal: log and continue — the StudentSchedule write already succeeded.
    // Wire to an alerting/retry queue in production.
    console.error('[syncTeacherSchedule] failed to sync TeacherSchedule:', err.message);
  }
};

/**
 * Generates a single VEVENT block (RFC 5545) for ICS export.
 */
const sessionToICSEvent = (session, tzid = 'UTC') => {
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return [
    'BEGIN:VEVENT',
    `UID:${session._id}@foruni-lms`,
    `DTSTART;TZID=${tzid}:${fmt(session.startTime)}`,
    `DTEND;TZID=${tzid}:${fmt(session.endTime)}`,
    `SUMMARY:${session.subject?.subject_name ?? 'Session'} (${session.sessionType})`,
    `DESCRIPTION:${session.topic ?? ''}`,
    `LOCATION:${session.room?.code ?? session.virtualMeeting?.meetingUrl ?? 'TBD'}`,
    `STATUS:${session.status === SCHEDULE_STATUS.CANCELLED ? 'CANCELLED' : 'CONFIRMED'}`,
    `LAST-MODIFIED:${fmt(session.updatedAt || new Date())}`,
    'END:VEVENT',
  ].join('\r\n');
};

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT SELF-SERVICE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/schedules/student/me
 * Personal calendar for the connected student.
 * classId is resolved from the DB (not from JWT — JWT only carries id/role/campusId).
 * Campus isolation: the student record is fetched with schoolCampus === req.user.campusId.
 * Query: from?, to?, sessionType?
 */
const getMyCalendar = asyncHandler(async (req, res) => {
  const { from, to, sessionType } = req.query;
  const { id: userId, campusId }  = req.user;

  // Resolve classId from DB — JWT does not carry it
  const classId = await resolveStudentClass(userId, campusId);

  if (!classId) {
    return sendError(res, 400, 'No class found for this student. Please contact administration.');
  }

  // Default window: start of current week (Mon) → +7 days
  // Use separate Date objects to avoid mutation side-effects
  const now   = new Date();
  const start = from
    ? new Date(from)
    : (() => { const d = new Date(now); d.setDate(d.getDate() - d.getDay()); d.setHours(0,0,0,0); return d; })();
  const end   = to
    ? new Date(to)
    : new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);

  if (isNaN(start) || isNaN(end)) return sendError(res, 400, 'Invalid date range. Use ISO 8601.');
  if (end <= start)               return sendError(res, 400, "'to' must be after 'from'.");

  const filter = {
    'classes.classId': classId,
    schoolCampus:      campusId,
    startTime:         { $gte: start },
    endTime:           { $lte: end },
    status:            SCHEDULE_STATUS.PUBLISHED,
    isDeleted:         false,
  };

  if (sessionType && Object.values(SESSION_TYPE).includes(sessionType)) {
    filter.sessionType = sessionType;
  }

  const sessions = await StudentSchedule.find(filter)
    .sort({ startTime: 1 })
    .select('-__v')
    .lean();

  return sendSuccess(res, 200, 'Calendar fetched successfully.', sessions, {
    count: sessions.length,
    from:  start,
    to:    end,
  });
});

/**
 * GET /api/schedules/student/:id
 * Single published session detail — accessible by the student.
 */
const getSessionById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid session ID.');

  const session = await StudentSchedule.findOne({
    _id:       id,
    isDeleted: false,
    status:    SCHEDULE_STATUS.PUBLISHED,
  })
    .select('-__v')
    .lean();

  if (!session) return sendError(res, 404, 'Session not found or not yet published.');
  return sendSuccess(res, 200, 'Session fetched.', session);
});

/**
 * GET /api/schedules/student/export/ics
 * ICS calendar download (Google Calendar / Apple / Outlook compatible).
 * classId resolved from DB — same campus-isolation pattern as getMyCalendar.
 * Query: from?, to?, tzid? (IANA timezone, default UTC)
 */
const exportCalendarICS = asyncHandler(async (req, res) => {
  const { from, to, tzid = 'UTC' } = req.query;
  const { id: userId, campusId }   = req.user;

  // Resolve classId from DB — JWT does not carry it
  const classId = await resolveStudentClass(userId, campusId);

  if (!classId) return sendError(res, 400, 'No class found for this student.');

  const start = from ? new Date(from) : new Date();
  const end   = to   ? new Date(to)   : new Date(start.getTime() + 90 * 24 * 60 * 60 * 1000);

  const sessions = await StudentSchedule.find({
    'classes.classId': classId,
    schoolCampus:      campusId,
    startTime:         { $gte: start },
    endTime:           { $lte: end },
    status:            SCHEDULE_STATUS.PUBLISHED,
    isDeleted:         false,
  })
    .sort({ startTime: 1 })
    .lean();

  const icsContent = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Foruni LMS//Student Schedule//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...sessions.map((s) => sessionToICSEvent(s, tzid)),
    'END:VCALENDAR',
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="my-schedule.ics"');
  return res.status(200).send(icsContent);
});

/**
 * GET /api/schedules/student/:id/attendance
 * Attendance summary for a specific session.
 */
const getAttendanceForSession = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid session ID.');

  const session = await StudentSchedule.findOne({ _id: id, isDeleted: false })
    .select('reference subject startTime endTime attendance')
    .lean();

  if (!session) return sendError(res, 404, 'Session not found.');

  return sendSuccess(res, 200, 'Attendance fetched.', {
    sessionReference: session.reference,
    subject:          session.subject,
    startTime:        session.startTime,
    endTime:          session.endTime,
    attendance:       session.attendance,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN / CAMPUS_MANAGER — SESSION MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/schedules/student/admin/sessions
 * Creates a new session (status: DRAFT).
 *
 * The frontend sends flat IDs:
 *   subjectId, teacherId, classIds[], plus timing, location, academic context.
 *
 * This controller:
 *   1. Resolves all IDs against the DB (with campus-isolation checks).
 *   2. Runs conflict detection (class double-booking + teacher double-booking).
 *   3. Persists the session with properly denormalised nested objects.
 */
const createSession = asyncHandler(async (req, res) => {
  const {
    subjectId,
    teacherId,
    classIds = [],
    schoolCampus: campusFromBody,
    sessionType,
    startTime: startRaw,
    endTime:   endRaw,
    isVirtual  = false,
    room,
    virtualMeeting,
    academicYear,
    semester,
    topic,
    description,
    recurrence,
    status = 'DRAFT',
  } = req.body;

  // ── Campus resolution ───────────────────────────────────────────────────────
  const resolvedCampus = resolveWriteCampus(req, campusFromBody);
  if (!resolvedCampus) return sendError(res, 400, 'Campus is required.');

  // ── Basic field validation ──────────────────────────────────────────────────
  if (!sessionType || !Object.values(SESSION_TYPE).includes(sessionType)) {
    return sendError(res, 400, `Invalid sessionType. Must be one of: ${Object.values(SESSION_TYPE).join(', ')}.`);
  }
  if (!startRaw || !endRaw) return sendError(res, 400, 'startTime and endTime are required.');
  if (!academicYear || !/^\d{4}-\d{4}$/.test(academicYear)) {
    return sendError(res, 400, 'academicYear must match YYYY-YYYY (e.g. 2024-2025).');
  }
  if (!semester || !Object.values(SEMESTER).includes(semester)) {
    return sendError(res, 400, `semester must be one of: ${Object.values(SEMESTER).join(', ')}.`);
  }
  if (!classIds.length) return sendError(res, 400, 'At least one classId is required.');
  if (!subjectId)       return sendError(res, 400, 'subjectId is required.');
  if (!teacherId)       return sendError(res, 400, 'teacherId is required.');

  const startTime = new Date(startRaw);
  const endTime   = new Date(endRaw);

  if (isNaN(startTime) || isNaN(endTime)) return sendError(res, 400, 'Invalid date values.');
  if (endTime <= startTime) return sendError(res, 400, 'endTime must be after startTime.');

  // ── Resolve participants from DB (with campus-isolation checks) ─────────────
  const { subject, teacher, classes, errors } = await resolveSessionParticipants(
    { subjectId, teacherId, classIds },
    resolvedCampus
  );

  if (errors.length > 0) return sendError(res, 400, errors.join(' | '));

  // ── Class double-booking detection ──────────────────────────────────────────
  const { hasConflict, conflicts } = await StudentSchedule.detectConflicts({
    startTime,
    endTime,
    schoolCampus: resolvedCampus,
    roomCode:     room?.code,
    classIds:     classes.map((c) => c.classId),
  });
  if (hasConflict) return sendError(res, 409, 'Scheduling conflict detected.', conflicts);

  // ── Teacher double-booking detection ────────────────────────────────────────
  const { hasConflict: teacherConflict, conflicts: teacherConflicts } =
    await TeacherSchedule.detectTeacherConflicts({
      teacherId: teacher.teacherId,
      startTime,
      endTime,
    });
  if (teacherConflict) {
    return sendError(res, 409, 'Teacher already has a session in this time slot.', teacherConflicts);
  }

  // ── Persist ─────────────────────────────────────────────────────────────────
  const session = await StudentSchedule.create({
    schoolCampus:   resolvedCampus,
    academicYear,
    semester,
    sessionType,
    startTime,
    endTime,
    isVirtual,
    subject,                // denormalised object built by resolveSessionParticipants
    teacher,                // denormalised object
    classes,                // denormalised array [{classId, className, level}]
    ...(isVirtual ? { virtualMeeting } : { room }),
    topic:          topic       || undefined,
    description:    description || undefined,
    recurrence:     recurrence  || undefined,
    status,
    lastModifiedBy: req.user.id,
  });

  // Mirror to TeacherSchedule so the teacher's calendar is immediately up to date.
  // Even for DRAFT sessions we sync so the teacher can see upcoming assignments.
  await syncTeacherSchedule(session.toObject(), req.user.id);

  return sendSuccess(res, 201, 'Session created as DRAFT.', session);
});

/**
 * PUT /api/schedules/student/admin/sessions/:id
 * Updates an existing session. Re-runs conflict detection on changed fields.
 */
const updateSession = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid session ID.');

  const campusFilter = buildCampusFilter(req);
  const session = await StudentSchedule.findOne({ _id: id, isDeleted: false, ...campusFilter });
  if (!session) return sendError(res, 404, 'Session not found.');

  const {
    subjectId,
    teacherId,
    classIds,
    startTime: startRaw,
    endTime:   endRaw,
    isVirtual,
    room,
    virtualMeeting,
    ...otherFields
  } = req.body;

  const newStart = startRaw ? new Date(startRaw) : session.startTime;
  const newEnd   = endRaw   ? new Date(endRaw)   : session.endTime;

  if (isNaN(newStart) || isNaN(newEnd)) return sendError(res, 400, 'Invalid date values.');
  if (newEnd <= newStart) return sendError(res, 400, 'endTime must be after startTime.');

  // Resolve participants only when IDs are explicitly provided in the update body
  const needsResolve = subjectId || teacherId || classIds;
  let resolvedSubject = session.subject;
  let resolvedTeacher = session.teacher;
  let resolvedClasses = session.classes;

  if (needsResolve) {
    const campusId = session.schoolCampus.toString();
    const { subject, teacher, classes, errors } = await resolveSessionParticipants(
      {
        subjectId: subjectId || session.subject.subjectId.toString(),
        teacherId: teacherId || session.teacher.teacherId.toString(),
        classIds:  classIds  || session.classes.map((c) => c.classId.toString()),
      },
      campusId
    );
    if (errors.length > 0) return sendError(res, 400, errors.join(' | '));
    resolvedSubject = subject;
    resolvedTeacher = teacher;
    resolvedClasses = classes;
  }

  // Conflict detection (exclude current session)
  const { hasConflict, conflicts } = await StudentSchedule.detectConflicts({
    startTime:    newStart,
    endTime:      newEnd,
    schoolCampus: session.schoolCampus,
    roomCode:     (isVirtual === false ? room?.code : null) ?? session.room?.code,
    classIds:     resolvedClasses.map((c) => c.classId),
    excludeId:    session._id,
  });
  if (hasConflict) return sendError(res, 409, 'Scheduling conflict detected.', conflicts);

  const { hasConflict: teacherConflict, conflicts: teacherConflicts } =
    await TeacherSchedule.detectTeacherConflicts({
      teacherId:  resolvedTeacher.teacherId,
      startTime:  newStart,
      endTime:    newEnd,
      excludeId:  session.studentScheduleRef,
    });
  if (teacherConflict) {
    return sendError(res, 409, 'Teacher conflict after update.', teacherConflicts);
  }

  const wasPublished = session.status === SCHEDULE_STATUS.PUBLISHED;

  // Apply scalar fields from the allowed list
  const ALLOWED_SCALAR = [
    'sessionType', 'academicYear', 'semester', 'topic',
    'description', 'recurrence', 'status',
  ];
  ALLOWED_SCALAR.forEach((f) => {
    if (req.body[f] !== undefined) session[f] = req.body[f];
  });

  session.startTime = newStart;
  session.endTime   = newEnd;
  session.subject   = resolvedSubject;
  session.teacher   = resolvedTeacher;
  session.classes   = resolvedClasses;

  // Update location block
  if (isVirtual !== undefined) session.isVirtual = isVirtual;
  if (session.isVirtual) {
    if (virtualMeeting) session.virtualMeeting = virtualMeeting;
  } else {
    if (room) session.room = room;
  }

  session.lastModifiedBy = req.user.id;
  await session.save();

  // Keep TeacherSchedule in sync with every mutation (timing, teacher, classes, status…)
  await syncTeacherSchedule(session.toObject(), req.user.id);

  if (wasPublished) await dispatchNotification('SESSION_MODIFIED', session);

  return sendSuccess(res, 200, 'Session updated successfully.', session);
});

/**
 * PATCH /api/schedules/student/admin/sessions/:id/publish
 * Transitions a DRAFT session to PUBLISHED.
 */
const publishSession = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid session ID.');

  const session = await StudentSchedule.findOne({
    _id: id, isDeleted: false, ...buildCampusFilter(req),
  });
  if (!session)                                        return sendError(res, 404, 'Session not found.');
  if (session.status === SCHEDULE_STATUS.PUBLISHED)    return sendError(res, 400, 'Session is already published.');
  if (session.status === SCHEDULE_STATUS.CANCELLED)    return sendError(res, 400, 'Cannot publish a cancelled session.');

  session.status         = SCHEDULE_STATUS.PUBLISHED;
  session.publishedAt    = new Date();
  session.publishedBy    = req.user.id;
  session.lastModifiedBy = req.user.id;
  await session.save();

  // Mirror published status to the TeacherSchedule so the teacher sees the session
  await syncTeacherSchedule(session.toObject(), req.user.id);

  await dispatchNotification('SESSION_PUBLISHED', session);

  return sendSuccess(res, 200, 'Session published.', session);
});

/**
 * PATCH /api/schedules/student/admin/sessions/:id/cancel
 * Cancels a session and dispatches notifications.
 * Body: { reason? }
 */
const cancelSession = asyncHandler(async (req, res) => {
  const { id }          = req.params;
  const { reason = '' } = req.body;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid session ID.');

  const session = await StudentSchedule.findOne({
    _id: id, isDeleted: false, ...buildCampusFilter(req),
  });
  if (!session)                                     return sendError(res, 404, 'Session not found.');
  if (session.status === SCHEDULE_STATUS.CANCELLED) return sendError(res, 400, 'Session is already cancelled.');

  session.status         = SCHEDULE_STATUS.CANCELLED;
  session.lastModifiedBy = req.user.id;
  if (reason) session.description = `[CANCELLED] ${reason}`;
  await session.save();

  // Propagate cancellation to TeacherSchedule so the teacher's view is consistent
  await syncTeacherSchedule(session.toObject(), req.user.id);

  await dispatchNotification('SESSION_CANCELLED', session);

  return sendSuccess(res, 200, 'Session cancelled.', session);
});

/**
 * DELETE /api/schedules/student/admin/sessions/:id
 * Soft-deletes a session (sets isDeleted: true).
 */
const softDeleteSession = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid session ID.');

  const session = await StudentSchedule.findOneAndUpdate(
    { _id: id, isDeleted: false, ...buildCampusFilter(req) },
    { isDeleted: true, deletedAt: new Date(), deletedBy: req.user.id, lastModifiedBy: req.user.id },
    { new: true }
  );
  if (!session) return sendError(res, 404, 'Session not found.');

  return sendSuccess(res, 200, 'Session deleted.', { _id: session._id });
});

// ─────────────────────────────────────────────────────────────────────────────
// ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/schedules/student/admin/overview
 * Paginated session overview with optional filters.
 * Query: from, to, status, roomCode, teacherId, classId, page, limit
 *
 * Default window: today → today + 90 days (covers a full academic term).
 * Callers can pass `from`/`to` ISO strings to override.
 */
const getCampusOverview = asyncHandler(async (req, res) => {
  const {
    from, to, status, roomCode, teacherId, classId,
    page = 1, limit = 50,
  } = req.query;

  const now   = new Date();
  // Default: start of today → 90 days ahead (wide enough for term scheduling)
  const start = from ? new Date(from) : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end   = to   ? new Date(to)   : new Date(start.getTime() + 90 * 24 * 60 * 60 * 1000);

  const filter = {
    startTime: { $gte: start },
    endTime:   { $lte: end },
    isDeleted: false,
    ...buildCampusFilter(req),
  };

  if (status   && Object.values(SCHEDULE_STATUS).includes(status)) filter.status = status;
  if (roomCode)                                filter['room.code']         = roomCode;
  if (teacherId && isValidObjectId(teacherId)) filter['teacher.teacherId'] = new mongoose.Types.ObjectId(teacherId);
  if (classId   && isValidObjectId(classId))   filter['classes.classId']   = new mongoose.Types.ObjectId(classId);

  const pageNum  = parsePositiveInt(page, 1);
  const limitNum = parsePositiveInt(limit, 50);

  const [sessions, total] = await Promise.all([
    StudentSchedule.find(filter)
      .sort({ startTime: 1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .select('-__v')
      .lean(),
    StudentSchedule.countDocuments(filter),
  ]);

  return sendPaginated(res, 200, 'Overview fetched.', sessions, { total, page: pageNum, limit: limitNum });
});

/**
 * GET /api/schedules/student/admin/room-occupancy
 * Room occupancy report (aggregation).
 * Query: from?, to?
 */
const getRoomOccupancyReport = asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const now   = new Date();
  const start = from ? new Date(from) : new Date(now.getFullYear(), now.getMonth(), 1);
  const end   = to   ? new Date(to)   : new Date(now.getFullYear(), now.getMonth() + 1, 0);

  const matchStage = {
    startTime:    { $gte: start },
    endTime:      { $lte: end },
    isDeleted:    false,
    status:       { $in: [SCHEDULE_STATUS.PUBLISHED, SCHEDULE_STATUS.CANCELLED] },
    'room.code':  { $exists: true, $ne: null },
    ...buildCampusFilter(req),
  };

  const report = await StudentSchedule.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id:               '$room.code',
        capacity:          { $first: '$room.capacity' },
        totalSessions:     { $sum: 1 },
        confirmedSessions: { $sum: { $cond: [{ $eq: ['$status', SCHEDULE_STATUS.PUBLISHED] }, 1, 0] } },
        cancelledSessions: { $sum: { $cond: [{ $eq: ['$status', SCHEDULE_STATUS.CANCELLED] }, 1, 0] } },
        totalMinutes:      { $sum: '$durationMinutes' },
      },
    },
    {
      $project: {
        roomCode:          '$_id',
        capacity:          1,
        totalSessions:     1,
        confirmedSessions: 1,
        cancelledSessions: 1,
        totalHours:        { $round: [{ $divide: ['$totalMinutes', 60] }, 1] },
        cancellationRate: {
          $cond: [
            { $gt: ['$totalSessions', 0] },
            { $round: [{ $multiply: [{ $divide: ['$cancelledSessions', '$totalSessions'] }, 100] }, 1] },
            0,
          ],
        },
      },
    },
    { $sort: { totalSessions: -1 } },
  ]);

  return sendSuccess(res, 200, 'Room occupancy report fetched.', report, {
    from, to, totalRooms: report.length,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Student self-service
  getMyCalendar,
  getSessionById,
  exportCalendarICS,
  getAttendanceForSession,
  // Admin / Campus Manager
  createSession,
  updateSession,
  publishSession,
  cancelSession,
  softDeleteSession,
  getCampusOverview,
  getRoomOccupancyReport,
};