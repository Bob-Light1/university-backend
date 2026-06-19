'use strict';

/**
 * @file gaet.controller.js
 * @description REST controller for GAET — Générateur Automatique d'Emploi du Temps.
 *
 *  Campus isolation contract:
 *  ─────────────────────────────────────────────────────────────────────────────
 *  • READ endpoints (getConstraints, getStatus, getPreview, getConflicts):
 *      ADMIN / DIRECTOR get an unrestricted filter (all campuses) or optionally
 *      narrow via ?campusId= / :campusId.
 *      CAMPUS_MANAGER is locked to their JWT campusId.
 *
 *  • WRITE endpoints (createOrUpdateConstraints, generateSchedule,
 *    publishSchedule, cancelGenerated):
 *      CAMPUS_MANAGER only — always locked to req.user.campusId.
 *      Route guard (authorize(['CAMPUS_MANAGER'])) enforces this at the router level.
 *
 *  Publication flow:
 *  ─────────────────────────────────────────────────────────────────────────────
 *  For each generatedSession → resolveSessionParticipants() → create StudentSchedule
 *  → syncTeacherSchedule().  Sessions are weekly-recurring (recurrence.frequency = WEEKLY).
 *
 *  Routes (registered as /api/gaet in server.js):
 *    GET    /constraints/:campusId        → getConstraints
 *    GET    /status/:constraintId         → getStatus
 *    GET    /preview/:constraintId        → getPreview
 *    GET    /conflicts/:constraintId      → getConflicts
 *    POST   /constraints                  → createOrUpdateConstraints
 *    POST   /generate                     → generateSchedule
 *    POST   /publish/:constraintId        → publishSchedule
 *    DELETE /generated/:constraintId      → cancelGenerated
 */

const path            = require('path');
const { Worker }      = require('worker_threads');

const { GAET_STATUS } = require('../gaet-constraint.model'); // constante (enum)
const gaetRepo        = require('../gaet.repository');

const { SCHEDULE_STATUS, SESSION_TYPE } = require('../../../shared/utils/schedule.base');

const {
  resolveSessionParticipants,
  syncTeacherSchedule,
  createScheduleSession,
} = require('../../student').service;

const { isValidObjectId, buildCampusFilter: _buildCampusFilter } = require('../../../shared/utils/validation-helpers');

const {
  sendSuccess,
  sendError,
  sendForbidden,
  asyncHandler,
} = require('../../../shared/utils/response-helpers');

const { detectConflicts } = require('../gaet.conflict.service');

// ─────────────────────────────────────────────
// LOCAL HELPERS
// ─────────────────────────────────────────────

// Bulk campus guards, via the owning module facades
const countSubjectsOnCampus = (...args) =>
  require('../../subject').service.countSubjectsOnCampus(...args);
const countTeachersOnCampus = (...args) =>
  require('../../teacher').service.countTeachersOnCampus(...args);
const countClassesOnCampus = (...args) =>
  require('../../class').service.countClassesOnCampus(...args);

/**
 * Campus filter for READ operations.
 * Wraps the project's shared buildCampusFilter so that a malformed JWT
 * (missing campusId for a non-global role) sends a 403 instead of leaking
 * every campus's data ({schoolCampus: undefined} → full-collection scan).
 */
const getCampusFilter = (req, res, paramCampusId = null) => {
  try {
    return _buildCampusFilter(req.user, paramCampusId || req.query.campusId || null);
  } catch {
    sendForbidden(res, 'Campus information is missing from your session.');
    return null;
  }
};

/**
 * Campus filter for WRITE operations (CAMPUS_MANAGER only — always JWT campusId).
 */
const getWriteCampusFilter = (req, res) => {
  try {
    return _buildCampusFilter(req.user, null);
  } catch {
    sendForbidden(res, 'Campus information is missing from your session.');
    return null;
  }
};

// JS weekday index for each GAET WEEKDAY enum value
const WEEKDAY_TO_JS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/**
 * Returns the next Date on the given weekday (starting from tomorrow)
 * with the given hour set (fractional hour supported, e.g. 9.5 → 09:30).
 */
const nextWeekdayDate = (weekday, hour) => {
  const target = WEEKDAY_TO_JS[weekday];
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  while (d.getDay() !== target) d.setDate(d.getDate() + 1);
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  d.setHours(h, m, 0, 0);
  return d;
};

// ─────────────────────────────────────────────
// READ ENDPOINTS
// ─────────────────────────────────────────────

/**
 * GET /api/gaet/constraints/:campusId
 * Query: ?academicYear=2024-2025&semester=S1
 *
 * Returns all GaetConstraint docs for the campus (minus generatedSessions for
 * list views — use GET /preview/:id to fetch the sessions).
 */
const getConstraints = asyncHandler(async (req, res) => {
  const campusFilter = getCampusFilter(req, res, req.params.campusId);
  if (!campusFilter) return;
  const { academicYear, semester } = req.query;

  const query = { ...campusFilter };
  if (academicYear) query.academicYear = academicYear;
  if (semester)     query.semester     = semester;

  const constraints = await gaetRepo.listForCampus(query);

  return sendSuccess(res, 200, 'Constraints fetched.', constraints, { count: constraints.length });
});

/**
 * GET /api/gaet/status/:constraintId
 * Polling endpoint for the frontend while status === GENERATING.
 * Returns: status, qualityReport, generatedAt, generatingStartedAt, generationVersion.
 */
const getStatus = asyncHandler(async (req, res) => {
  const { constraintId } = req.params;
  if (!isValidObjectId(constraintId)) return sendError(res, 400, 'Invalid constraint ID.');

  const campusFilter = getCampusFilter(req, res);
  if (!campusFilter) return;

  const constraint = await gaetRepo.findStatusView(constraintId, campusFilter);

  if (!constraint) return sendError(res, 404, 'Constraint not found.');

  return sendSuccess(res, 200, 'Status fetched.', constraint);
});

/**
 * GET /api/gaet/preview/:constraintId
 * Returns the full generatedSessions array before publication.
 * Status must be GENERATED or PARTIALLY_GENERATED.
 */
const getPreview = asyncHandler(async (req, res) => {
  const { constraintId } = req.params;
  if (!isValidObjectId(constraintId)) return sendError(res, 400, 'Invalid constraint ID.');

  const campusFilter = getCampusFilter(req, res);
  if (!campusFilter) return;

  const constraint = await gaetRepo.findPreviewView(constraintId, campusFilter);

  if (!constraint) return sendError(res, 404, 'Constraint not found.');

  if (!constraint.generatedSessions?.length) {
    return sendError(res, 422, 'No generated sessions available. Run generation first.');
  }

  return sendSuccess(res, 200, 'Preview fetched.', {
    status:        constraint.status,
    academicYear:  constraint.academicYear,
    semester:      constraint.semester,
    sessionsCount: constraint.generatedSessions.length,
    sessions:      constraint.generatedSessions,
    qualityReport: constraint.qualityReport,
  });
});

/**
 * GET /api/gaet/conflicts/:constraintId
 * Returns the residual conflict report: detected overlaps + unplaced courses.
 * The backtracker prevents conflicts by design; this is an independent second-pass.
 */
const getConflicts = asyncHandler(async (req, res) => {
  const { constraintId } = req.params;
  if (!isValidObjectId(constraintId)) return sendError(res, 400, 'Invalid constraint ID.');

  const campusFilter = getCampusFilter(req, res);
  if (!campusFilter) return;

  const constraint = await gaetRepo.findConflictsView(constraintId, campusFilter);

  if (!constraint) return sendError(res, 404, 'Constraint not found.');

  if (!constraint.generatedSessions?.length) {
    return sendSuccess(res, 200, 'No generated sessions — no conflicts to report.', {
      conflictCount:   0,
      conflicts:       [],
      unplacedCourses: [],
    });
  }

  const conflicts = detectConflicts(constraint.generatedSessions, constraint.courseRequirements);

  return sendSuccess(res, 200, 'Conflict report.', {
    conflictCount:   conflicts.length,
    conflicts,
    unplacedCourses: constraint.qualityReport?.unplacedCourses || [],
  });
});

// ─────────────────────────────────────────────
// WRITE ENDPOINTS
// ─────────────────────────────────────────────

/**
 * POST /api/gaet/constraints
 * Creates or updates (upsert) the GaetConstraint for the requesting campus.
 *
 * Rules:
 *  - Cannot modify while GENERATING (worker is running).
 *  - Cannot modify when PUBLISHED (constraint represents a live timetable).
 *  - If GENERATED/PARTIALLY_GENERATED, updating clears the generated data → DRAFT.
 *
 * Body: { academicYear, semester, timeSlots?, courseRequirements?, roomRegistry?, teacherPreferences? }
 */
const createOrUpdateConstraints = asyncHandler(async (req, res) => {
  const campusFilter = getWriteCampusFilter(req, res);
  if (!campusFilter) return;
  const { academicYear, semester, timeSlots, courseRequirements, roomRegistry, teacherPreferences } = req.body;

  const existing = await gaetRepo.findByYearSemester(campusFilter, academicYear, semester);

  if (existing) {
    if (existing.status === GAET_STATUS.GENERATING) {
      return sendError(res, 409, 'Cannot modify constraints while generation is in progress.');
    }
    if (existing.status === GAET_STATUS.PUBLISHED) {
      return sendError(res, 409, 'Cannot modify constraints of a published timetable. Cancel the published schedule first.');
    }
  }

  // Issue 2: validate that all IDs in courseRequirements belong to this campus
  if (courseRequirements !== undefined && courseRequirements.length > 0) {
    const campusId   = String(req.user.campusId);
    const classIds   = [...new Set(courseRequirements.map(cr => cr.classId))];
    const subjectIds = [...new Set(courseRequirements.map(cr => cr.subjectId))];
    const teacherIds = [...new Set(courseRequirements.map(cr => cr.teacherId))];

    const [classCount, subjectCount, teacherCount] = await Promise.all([
      countClassesOnCampus(classIds, campusId),
      countSubjectsOnCampus(subjectIds, campusId),
      countTeachersOnCampus(teacherIds, campusId),
    ]);

    if (classCount !== classIds.length)
      return sendError(res, 422, 'One or more classId values do not belong to your campus.');
    if (subjectCount !== subjectIds.length)
      return sendError(res, 422, 'One or more subjectId values do not belong to your campus.');
    if (teacherCount !== teacherIds.length)
      return sendError(res, 422, 'One or more teacherId values do not belong to your campus.');
  }

  const $set = { status: GAET_STATUS.DRAFT };
  if (timeSlots          !== undefined) $set.timeSlots          = timeSlots;
  if (courseRequirements !== undefined) $set.courseRequirements = courseRequirements;
  if (roomRegistry       !== undefined) $set.roomRegistry       = roomRegistry;
  if (teacherPreferences !== undefined) $set.teacherPreferences = teacherPreferences;

  const wasGenerated = existing && [GAET_STATUS.GENERATED, GAET_STATUS.PARTIALLY_GENERATED].includes(existing.status);
  if (wasGenerated) {
    $set.generatedSessions   = [];
    $set.qualityReport       = null;
    $set.generatedAt         = null;
    $set.generatedBy         = null;
    $set.generatingStartedAt = null;
  }

  const constraint = await gaetRepo.upsert(campusFilter, academicYear, semester, $set);

  const msg = wasGenerated
    ? 'Constraints updated. Previous generated timetable cleared — re-run generation.'
    : 'Constraints saved successfully.';

  return sendSuccess(res, 200, msg, constraint);
});

/**
 * POST /api/gaet/generate
 * Triggers timetable generation in a worker thread. Returns 202 immediately.
 * The frontend should poll GET /api/gaet/status/:constraintId until status changes.
 *
 * Body: { academicYear, semester }
 * Rate-limited by strictLimiter (3 req / hour) — CPU-heavy operation.
 */
const generateSchedule = asyncHandler(async (req, res) => {
  const campusFilter = getWriteCampusFilter(req, res);
  if (!campusFilter) return;
  const { academicYear, semester } = req.body;

  // Atomically set GENERATING — fails if already GENERATING or PUBLISHED.
  // Use { new: false } to get the document BEFORE the update so we can restore
  // the original status if pre-flight checks fail (instead of always resetting to DRAFT).
  const constraint = await gaetRepo.claimForGeneration(campusFilter, academicYear, semester);

  if (!constraint) {
    const existing = await gaetRepo.findByYearSemester(campusFilter, academicYear, semester);
    if (!existing) {
      return sendError(res, 404, 'No constraint document found for this campus / year / semester. Create constraints first.');
    }
    if (existing.status === GAET_STATUS.GENERATING) {
      return sendError(res, 409, 'Generation is already in progress for this timetable.');
    }
    if (existing.status === GAET_STATUS.PUBLISHED) {
      return sendError(res, 409, 'Timetable is already published. Cancel the published schedule before regenerating.');
    }
    return sendError(res, 409, `Cannot start generation from current status "${existing.status}".`);
  }

  // The original status before we set GENERATING (used to restore on pre-flight failure).
  const originalStatus = constraint.status;

  // Pre-flight: reject early if mandatory constraints are missing (avoids a worker thread for a trivially invalid config)
  if (!constraint.courseRequirements?.length) {
    await gaetRepo.restoreStatus(constraint._id, originalStatus);
    return sendError(res, 422, 'Cannot generate: no course requirements defined. Add courseRequirements first.');
  }

  if (!constraint.timeSlots?.length) {
    await gaetRepo.restoreStatus(constraint._id, originalStatus);
    return sendError(res, 422, 'Cannot generate: no time slots defined. Add timeSlots first.');
  }

  if (!constraint.roomRegistry?.length) {
    await gaetRepo.restoreStatus(constraint._id, originalStatus);
    return sendError(res, 422, 'Cannot generate: no rooms defined. Add roomRegistry first.');
  }

  // Capture userId now — the closure below executes asynchronously after the response is sent
  const actorId        = req.user.id;
  const currentVersion = constraint.generationVersion || 0;

  const worker = new Worker(
    path.join(__dirname, '../gaet.engine.worker.js'),
    { workerData: { constraintId: constraint._id.toString() } }
  );

  worker.on('message', async (result) => {
    try {
      await gaetRepo.applyWorkerResult(constraint._id, {
        status:            result.status,
        sessions:          result.sessions,
        report:            result.report,
        generatedBy:       actorId,
        generationVersion: currentVersion + 1,
      });
    } catch (err) {
      console.error('[GAET] Failed to persist worker result:', err.message);
    }
  });

  worker.on('error', async (err) => {
    console.error('[GAET] Worker runtime error:', err.message);
    try {
      await gaetRepo.markFailed(constraint._id);
    } catch (_) {}
  });

  worker.on('exit', (code) => {
    if (code !== 0) console.error(`[GAET] Worker exited with non-zero code: ${code}`);
  });

  return sendSuccess(res, 202, 'Generation started. Poll GET /api/gaet/status/:id for updates.', {
    constraintId: constraint._id,
    status:       GAET_STATUS.GENERATING,
  });
});

/**
 * POST /api/gaet/publish/:constraintId
 * Publishes a GENERATED or PARTIALLY_GENERATED timetable.
 *
 * For each generated session:
 *   1. Look up the CourseRequirement (subject, teacher, class IDs).
 *   2. Call resolveSessionParticipants() to build denormalised participant objects.
 *   3. Create a PUBLISHED StudentSchedule with weekly recurrence.
 *   4. Mirror to TeacherSchedule via syncTeacherSchedule().
 *
 * Sets constraint.status = PUBLISHED on success.
 */
const publishSchedule = asyncHandler(async (req, res) => {
  const { constraintId } = req.params;
  if (!isValidObjectId(constraintId)) return sendError(res, 400, 'Invalid constraint ID.');

  const campusFilter = getWriteCampusFilter(req, res);
  if (!campusFilter) return;

  const constraint = await gaetRepo.findForPublish(constraintId, campusFilter);
  if (!constraint) return sendError(res, 404, 'Constraint not found.');

  if (!constraint.isPublishable) {
    return sendError(
      res, 409,
      `Cannot publish from status "${constraint.status}". Status must be GENERATED or PARTIALLY_GENERATED.`
    );
  }

  if (!constraint.generatedSessions?.length) {
    return sendError(res, 422, 'No generated sessions to publish.');
  }

  const campusId    = constraint.schoolCampus.toString();
  const { academicYear, semester } = constraint;

  const crMap = new Map(
    constraint.courseRequirements.map(cr => [cr._id.toString(), cr])
  );

  const created = [];
  const errors  = [];

  for (const session of constraint.generatedSessions) {
    const cr = crMap.get(session.courseRequirementRef.toString());
    if (!cr) {
      errors.push(`Skipped session ${session._id}: courseRequirement ${session.courseRequirementRef} not found.`);
      continue;
    }

    try {
      const { subject, teacher, classes, errors: resolveErrors } = await resolveSessionParticipants(
        {
          subjectId: cr.subjectId.toString(),
          teacherId: cr.teacherId.toString(),
          classIds:  [cr.classId.toString()],
        },
        campusId
      );

      if (resolveErrors.length > 0) {
        errors.push(...resolveErrors.map(e => `Session for cr ${cr._id}: ${e}`));
        continue;
      }

      const { day, startHour, endHour } = session.slot;
      const startTime = nextWeekdayDate(day, startHour);
      const endTime   = nextWeekdayDate(day, endHour);

      const ss = await createScheduleSession({
        schoolCampus:      campusId,
        academicYear,
        semester,
        sessionType:       cr.sessionType || SESSION_TYPE.LECTURE,
        startTime,
        endTime,
        durationMinutes:   cr.sessionDuration,
        isVirtual:         false,
        room:              { code: session.roomName },
        subject,
        teacher,
        classes,
        expectedAttendees: cr.studentCount,
        recurrence: {
          frequency: 'WEEKLY',
          byDay:     [day],
          count:     18,
        },
        status:      SCHEDULE_STATUS.PUBLISHED,
        publishedAt: new Date(),
        publishedBy: req.user.id,
      });

      await syncTeacherSchedule(ss.toObject(), req.user.id);
      created.push(ss._id);
    } catch (err) {
      errors.push(`Failed to create session for courseRequirement ${cr._id}: ${err.message}`);
    }
  }

  if (created.length === 0) {
    return sendError(
      res, 422,
      `Publication failed: 0 sessions could be created (${errors.length} error(s)). Fix constraints and retry.`,
      { errors }
    );
  }

  await gaetRepo.markPublished(constraintId, req.user.id);

  return sendSuccess(res, 200, `Published ${created.length} session(s) successfully.`, {
    published: created.length,
    skipped:   errors.length,
    errors:    errors.length > 0 ? errors : undefined,
  });
});

/**
 * DELETE /api/gaet/generated/:constraintId
 * Cancels a generated (not yet published) timetable — sets status to CANCELLED.
 *
 * Allowed from: GENERATED, PARTIALLY_GENERATED, FAILED.
 * Rejected from: PUBLISHED (use schedule cancellation flow instead),
 *                GENERATING (wait for the worker to finish).
 */
const cancelGenerated = asyncHandler(async (req, res) => {
  const { constraintId } = req.params;
  if (!isValidObjectId(constraintId)) return sendError(res, 400, 'Invalid constraint ID.');

  const campusFilter = getWriteCampusFilter(req, res);
  if (!campusFilter) return;

  const constraint = await gaetRepo.cancel(constraintId, campusFilter);

  if (!constraint) {
    const existing = await gaetRepo.findInCampus(constraintId, campusFilter);
    if (!existing) return sendError(res, 404, 'Constraint not found.');
    if (existing.status === GAET_STATUS.PUBLISHED) {
      return sendError(res, 409, 'Cannot cancel a published timetable. Use the schedule cancellation flow instead.');
    }
    if (existing.status === GAET_STATUS.GENERATING) {
      return sendError(res, 409, 'Generation is in progress. Wait for it to complete before cancelling.');
    }
    return sendError(res, 409, 'Nothing to cancel — constraint has not been generated yet or was already cancelled.');
  }

  return sendSuccess(res, 200, 'Generated timetable cancelled.', {
    constraintId: constraint._id,
    status:       constraint.status,
  });
});

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  getConstraints,
  createOrUpdateConstraints,
  generateSchedule,
  getStatus,
  getPreview,
  publishSchedule,
  getConflicts,
  cancelGenerated,
};
