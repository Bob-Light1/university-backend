'use strict';

/**
 * @file exam_session_controller.js
 * @description ExamSession CRUD + status-machine transitions.
 *
 *  Routes (all prefixed /api/examination):
 *    GET    /sessions                     → listSessions
 *    POST   /sessions                     → createSession   (CAMPUS_MANAGER only)
 *    GET    /sessions/:id                 → getSession
 *    PATCH  /sessions/:id                 → updateSession   (CAMPUS_MANAGER only, DRAFT only)
 *    DELETE /sessions/:id                 → deleteSession   (CAMPUS_MANAGER only, DRAFT only)
 *    PATCH  /sessions/:id/submit          → submitSession   (CAMPUS_MANAGER only, DRAFT → SCHEDULED)
 *    PATCH  /sessions/:id/start           → startSession    (CAMPUS_MANAGER only, SCHEDULED → ONGOING)
 *    PATCH  /sessions/:id/complete        → completeSession (CAMPUS_MANAGER only, ONGOING → COMPLETED)
 *    PATCH  /sessions/:id/cancel          → cancelSession   (CAMPUS_MANAGER only)
 *    PATCH  /sessions/:id/postpone        → postponeSession (CAMPUS_MANAGER only, SCHEDULED → POSTPONED)
 *    PATCH  /sessions/:id/reschedule      → rescheduleSession (CAMPUS_MANAGER only, POSTPONED → SCHEDULED)
 */

const ExamSession    = require('../models/exam.session.model');
const ExamEnrollment = require('../models/exam.enrollment.model');
const QuestionBank   = require('../models/question-bank.model');
const Subject        = require('../../../models/subject.model');
const Class          = require('../../../models/class.model');
const Teacher        = require('../../../models/teacher-models/teacher.model');
const {
  sendSuccess,
  sendError,
  sendNotFound,
  sendCreated,
  sendPaginated,
} = require('../../../shared/utils/response-helpers');
const { isValidObjectId, escapeRegex } = require('../../../utils/validation-helpers');
const {
  getCampusFilter,
  resolveCampusId,
  parsePagination,
} = require('./exam.helper');
const {
  injectExamIntoSchedule,
  syncExamScheduleStatus,
} = require('./exam.schedule.helper');

// ─── Role guard ───────────────────────────────────────────────────────────────

const requireCampusManager = (res, role) => {
  if (role !== 'CAMPUS_MANAGER') {
    sendError(res, 403, 'Only Campus Managers can perform this action.');
    return false;
  }
  return true;
};

// ─────────────────────────────────────────────────────────────────────────────

const listSessions = async (req, res) => {
  try {
    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const { page, limit, skip } = parsePagination(req.query);
    const { classId, subject, examPeriod, status, academicYear, semester, search } = req.query;

    const match = { ...campusFilter, isDeleted: false };
    if (classId)      match.classes      = classId;
    if (subject)      match.subject      = subject;
    if (examPeriod)   match.examPeriod   = examPeriod;
    if (status) {
      const statuses = status.split(',').map((s) => s.trim()).filter(Boolean);
      match.status = statuses.length === 1 ? statuses[0] : { $in: statuses };
    }
    if (academicYear) match.academicYear = academicYear;
    if (semester)     match.semester     = semester;
    if (search)       match.title        = { $regex: escapeRegex(search), $options: 'i' };

    const [sessions, total] = await Promise.all([
      ExamSession.find(match)
        .select('-__v')
        .populate('subject',    'subject_name subject_code')
        .populate('classes',    'className level')
        .populate('teacher',    'firstName lastName')
        .sort({ startTime: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ExamSession.countDocuments(match),
    ]);

    return sendPaginated(res, 200, 'Sessions retrieved.', sessions, { total, page, limit });
  } catch (err) {
    console.error('❌ listSessions:', err);
    return sendError(res, 500, 'Failed to retrieve sessions.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

const createSession = async (req, res) => {
  try {
    if (!requireCampusManager(res, req.user.role)) return;

    const campusId = resolveCampusId(req, req.body.schoolCampus);
    if (!campusId) return sendError(res, 400, 'schoolCampus is required.');

    const {
      title, subject, classes, teacher, invigilators,
      academicYear, semester, examPeriod, mode,
      startTime, endTime, duration,
      room, virtualMeeting,
      questions, shuffleQuestions, shuffleOptions,
      maxScore, gradingScale, eligibilityRules,
      instructions, allowedMaterials, antiCheatConfig,
    } = req.body;

    const required = { title, subject, classes, teacher, academicYear, semester, examPeriod, mode, startTime, endTime, duration, maxScore };
    const missing  = Object.entries(required)
      .filter(([k, v]) => k === 'classes' ? !v?.length : !v)
      .map(([k]) => k);
    if (missing.length) return sendError(res, 400, `Missing required fields: ${missing.join(', ')}.`);

    // Val 1 — endTime must be after startTime
    if (new Date(endTime) <= new Date(startTime)) {
      return sendError(res, 400, 'endTime must be after startTime.');
    }

    // Val 2 — cross-campus validation for subject, classes, teacher
    const [subjectDoc, ...classDocs] = await Promise.all([
      Subject.findById(subject).select('schoolCampus').lean(),
      ...classes.map((cId) => Class.findById(cId).select('schoolCampus').lean()),
    ]);

    if (!subjectDoc) return sendError(res, 400, 'Subject not found.');
    if (subjectDoc.schoolCampus.toString() !== campusId.toString()) {
      return sendError(res, 400, 'Subject does not belong to this campus.');
    }

    for (const cls of classDocs) {
      if (!cls) return sendError(res, 400, 'One or more classes not found.');
      if (cls.schoolCampus.toString() !== campusId.toString()) {
        return sendError(res, 400, 'One or more classes do not belong to this campus.');
      }
    }

    const teacherDoc = await Teacher.findById(teacher).select('schoolCampus').lean();
    if (!teacherDoc) return sendError(res, 400, 'Teacher not found.');
    if (teacherDoc.schoolCampus.toString() !== campusId.toString()) {
      return sendError(res, 400, 'Teacher does not belong to this campus.');
    }

    const session = await ExamSession.create({
      schoolCampus: campusId,
      title, subject, classes, teacher, invigilators,
      academicYear, semester, examPeriod, mode,
      startTime, endTime, duration,
      room, virtualMeeting,
      questions, shuffleQuestions, shuffleOptions,
      maxScore, gradingScale, eligibilityRules,
      instructions, allowedMaterials, antiCheatConfig,
      status:    'DRAFT',
      createdBy: req.user.id,
    });

    if (questions?.length) {
      const ids = questions.map((q) => q.questionId).filter(Boolean);
      await QuestionBank.updateMany(
        { _id: { $in: ids } },
        { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } }
      );
    }

    return sendCreated(res, 'Exam session created.', session);
  } catch (err) {
    console.error('❌ createSession:', err);
    return sendError(res, 500, 'Failed to create exam session.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

const getSession = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid session ID.');

    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const session = await ExamSession.findOne({ _id: id, ...campusFilter, isDeleted: false })
      .populate('subject',      'subject_name subject_code')
      .populate('classes',      'className level')
      .populate('teacher',      'firstName lastName email')
      .populate('invigilators', 'firstName lastName email')
      .populate('gradingScale', 'name passMark')
      .populate({ path: 'questions.questionId', select: 'questionText questionType difficulty points' });

    if (!session) return sendNotFound(res, 'Exam session');

    const enrolledCount = await ExamEnrollment.countDocuments({ examSession: id, isDeleted: false });

    return sendSuccess(res, 200, 'Exam session retrieved.', { ...session.toObject(), enrolledCount });
  } catch (err) {
    console.error('❌ getSession:', err);
    return sendError(res, 500, 'Failed to retrieve exam session.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

const updateSession = async (req, res) => {
  try {
    if (!requireCampusManager(res, req.user.role)) return;

    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid session ID.');

    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const session = await ExamSession.findOne({ _id: id, ...campusFilter, isDeleted: false });
    if (!session) return sendNotFound(res, 'Exam session');
    if (session.status !== 'DRAFT') {
      return sendError(res, 400, 'Only DRAFT sessions can be updated.');
    }

    // Val 1 — endTime must be after startTime (when both are present in body)
    const newStart = req.body.startTime ?? session.startTime;
    const newEnd   = req.body.endTime   ?? session.endTime;
    if (new Date(newEnd) <= new Date(newStart)) {
      return sendError(res, 400, 'endTime must be after startTime.');
    }

    const IMMUTABLE = ['_id', 'schoolCampus', 'status', 'createdBy', 'createdAt', 'publishedAt', 'completedAt'];
    const updates   = { ...req.body, updatedBy: req.user.id };
    IMMUTABLE.forEach((f) => delete updates[f]);

    await ExamSession.findByIdAndUpdate(id, { $set: updates }, { runValidators: true });

    const updated = await ExamSession.findById(id)
      .populate('subject',      'subject_name subject_code')
      .populate('classes',      'className level')
      .populate('teacher',      'firstName lastName email')
      .populate('invigilators', 'firstName lastName email')
      .lean();

    return sendSuccess(res, 200, 'Exam session updated.', updated);
  } catch (err) {
    console.error('❌ updateSession:', err);
    return sendError(res, 500, 'Failed to update exam session.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

const deleteSession = async (req, res) => {
  try {
    if (!requireCampusManager(res, req.user.role)) return;

    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid session ID.');

    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const session = await ExamSession.findOne({ _id: id, ...campusFilter, isDeleted: false });
    if (!session) return sendNotFound(res, 'Exam session');
    if (session.status !== 'DRAFT') {
      return sendError(res, 400, 'Only DRAFT sessions can be deleted.');
    }

    await ExamSession.findByIdAndUpdate(id, { isDeleted: true, updatedBy: req.user.id });
    return sendSuccess(res, 200, 'Exam session deleted.');
  } catch (err) {
    console.error('❌ deleteSession:', err);
    return sendError(res, 500, 'Failed to delete exam session.');
  }
};

// ─── Status-machine helper ────────────────────────────────────────────────────

const _transition = async (req, res, { fromStatuses, toStatus, extraUpdates = {}, requiredBody = [] }) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid session ID.');

  const campusFilter = getCampusFilter(req, res);
  if (!campusFilter) return;

  const session = await ExamSession.findOne({ _id: id, ...campusFilter, isDeleted: false });
  if (!session) return sendNotFound(res, 'Exam session');

  if (!fromStatuses.includes(session.status)) {
    return sendError(
      res, 400,
      `Cannot transition from ${session.status} to ${toStatus}. Allowed from: ${fromStatuses.join(', ')}.`
    );
  }

  for (const field of requiredBody) {
    if (!req.body[field]) return sendError(res, 400, `${field} is required.`);
  }

  const updated = await ExamSession.findByIdAndUpdate(
    id,
    { $set: { status: toStatus, updatedBy: req.user.id, ...extraUpdates } },
    { new: true }
  );

  return updated;
};

// ─────────────────────────────────────────────────────────────────────────────

const submitSession = async (req, res) => {
  try {
    if (!requireCampusManager(res, req.user.role)) return;

    const updated = await _transition(req, res, {
      fromStatuses: ['DRAFT'],
      toStatus:     'SCHEDULED',
      extraUpdates: { publishedAt: new Date() },
    });
    if (!updated) return;

    // Inject exam into StudentSchedule + TeacherSchedule (non-blocking)
    injectExamIntoSchedule(updated._id).catch((err) =>
      console.error('❌ injectExamIntoSchedule:', err)
    );

    return sendSuccess(res, 200, 'Session scheduled and published.', updated);
  } catch (err) {
    console.error('❌ submitSession:', err);
    return sendError(res, 500, 'Failed to schedule session.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

const startSession = async (req, res) => {
  try {
    if (!requireCampusManager(res, req.user.role)) return;

    const updated = await _transition(req, res, {
      fromStatuses: ['SCHEDULED'],
      toStatus:     'ONGOING',
    });
    if (!updated) return;
    return sendSuccess(res, 200, 'Session started.', updated);
  } catch (err) {
    console.error('❌ startSession:', err);
    return sendError(res, 500, 'Failed to start session.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

const completeSession = async (req, res) => {
  try {
    if (!requireCampusManager(res, req.user.role)) return;

    const updated = await _transition(req, res, {
      fromStatuses: ['ONGOING'],
      toStatus:     'COMPLETED',
      extraUpdates: { completedAt: new Date() },
    });
    if (!updated) return;

    const { examAnalyticsWorker } = require('../exam-analytics.worker');
    examAnalyticsWorker.emit('examAnalytics:compute', updated._id.toString());

    return sendSuccess(res, 200, 'Session completed.', updated);
  } catch (err) {
    console.error('❌ completeSession:', err);
    return sendError(res, 500, 'Failed to complete session.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

const cancelSession = async (req, res) => {
  try {
    if (!requireCampusManager(res, req.user.role)) return;

    const updated = await _transition(req, res, {
      fromStatuses: ['SCHEDULED', 'ONGOING'],
      toStatus:     'CANCELLED',
      requiredBody: ['reason'],
      extraUpdates: { cancellationReason: req.body.reason },
    });
    if (!updated) return;

    syncExamScheduleStatus(updated._id, 'CANCELLED').catch((err) =>
      console.error('❌ syncExamScheduleStatus cancel:', err)
    );

    return sendSuccess(res, 200, 'Session cancelled.', updated);
  } catch (err) {
    console.error('❌ cancelSession:', err);
    return sendError(res, 500, 'Failed to cancel session.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

const postponeSession = async (req, res) => {
  try {
    if (!requireCampusManager(res, req.user.role)) return;

    const { startTime, endTime, reason } = req.body;
    if (!startTime || !endTime || !reason) {
      return sendError(res, 400, 'startTime, endTime and reason are required.');
    }
    if (new Date(endTime) <= new Date(startTime)) {
      return sendError(res, 400, 'endTime must be after startTime.');
    }

    const updated = await _transition(req, res, {
      fromStatuses: ['SCHEDULED'],
      toStatus:     'POSTPONED',
      extraUpdates: { startTime, endTime, postponeReason: reason },
    });
    if (!updated) return;

    syncExamScheduleStatus(updated._id, 'POSTPONED', { startTime, endTime }).catch((err) =>
      console.error('❌ syncExamScheduleStatus postpone:', err)
    );

    return sendSuccess(res, 200, 'Session postponed.', updated);
  } catch (err) {
    console.error('❌ postponeSession:', err);
    return sendError(res, 500, 'Failed to postpone session.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

const rescheduleSession = async (req, res) => {
  try {
    if (!requireCampusManager(res, req.user.role)) return;

    const { startTime, endTime, reason } = req.body;
    if (!startTime || !endTime || !reason) {
      return sendError(res, 400, 'startTime, endTime and reason are required.');
    }
    if (new Date(endTime) <= new Date(startTime)) {
      return sendError(res, 400, 'endTime must be after startTime.');
    }

    const updated = await _transition(req, res, {
      fromStatuses: ['POSTPONED'],
      toStatus:     'SCHEDULED',
      extraUpdates: { startTime, endTime, rescheduleReason: reason },
    });
    if (!updated) return;

    // Re-inject with updated times (idempotent upsert)
    injectExamIntoSchedule(updated._id).catch((err) =>
      console.error('❌ injectExamIntoSchedule reschedule:', err)
    );

    return sendSuccess(res, 200, 'Session rescheduled.', updated);
  } catch (err) {
    console.error('❌ rescheduleSession:', err);
    return sendError(res, 500, 'Failed to reschedule session.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  listSessions,
  createSession,
  getSession,
  updateSession,
  deleteSession,
  submitSession,
  startSession,
  completeSession,
  cancelSession,
  postponeSession,
  rescheduleSession,
};
