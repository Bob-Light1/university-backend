'use strict';

/**
 * @file exam_session_controller.js
 * @description ExamSession CRUD + status-machine transitions.
 *
 *  Routes (all prefixed /api/examination):
 *    GET    /sessions                     → listSessions
 *    POST   /sessions                     → createSession
 *    GET    /sessions/:id                 → getSession
 *    PATCH  /sessions/:id                 → updateSession  (DRAFT only)
 *    DELETE /sessions/:id                 → deleteSession  (DRAFT only)
 *    PATCH  /sessions/:id/submit          → submitSession
 *    PATCH  /sessions/:id/approve         → approveSession
 *    PATCH  /sessions/:id/publish         → publishSession
 *    PATCH  /sessions/:id/start           → startSession
 *    PATCH  /sessions/:id/complete        → completeSession
 *    PATCH  /sessions/:id/cancel          → cancelSession
 *    PATCH  /sessions/:id/postpone        → postponeSession
 */

const ExamSession    = require('../../models/exam-models/examSession.model');
const ExamEnrollment = require('../../models/exam-models/examEnrollment.model');
const QuestionBank   = require('../../models/exam-models/questionBank.model');
const {
  sendSuccess,
  sendError,
  sendNotFound,
  sendCreated,
  sendPaginated,
} = require('../../utils/responseHelpers');
const { isValidObjectId } = require('../../utils/validationHelpers');
const {
  getCampusFilter,
  resolveCampusId,
  isManagerRole,
  parsePagination,
} = require('./exam.helper');

// ─────────────────────────────────────────────────────────────────────────────

const listSessions = async (req, res) => {
  try {
    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const { page, limit, skip } = parsePagination(req.query);
    const { classId, subject, examPeriod, status, academicYear, semester, search } = req.query;

    const match = { ...campusFilter, isDeleted: false };
    if (classId)      match.classes     = classId;
    if (subject)      match.subject     = subject;
    if (examPeriod)   match.examPeriod  = examPeriod;
    if (status)       match.status      = status;
    if (academicYear) match.academicYear = academicYear;
    if (semester)     match.semester    = semester;
    if (search)       match.title       = { $regex: search, $options: 'i' };

    const [sessions, total] = await Promise.all([
      ExamSession.find(match)
        .select('-__v')
        .populate('subject',    'subject_name subject_code')
        .populate('classes',    'name level')
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
    if (!isManagerRole(req.user.role)) {
      return sendError(res, 403, 'Only managers can create exam sessions.');
    }

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
    const missing  = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) return sendError(res, 400, `Missing required fields: ${missing.join(', ')}.`);

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

    // Increment usageCount on referenced questions
    if (questions && questions.length) {
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
      .populate('classes',      'name level')
      .populate('teacher',      'firstName lastName email')
      .populate('invigilators', 'firstName lastName email')
      .populate('gradingScale', 'name passMark')
      .populate({ path: 'questions.questionId', select: 'questionText questionType difficulty points' });

    if (!session) return sendNotFound(res, 'Exam session');

    const enrolledCount = await ExamEnrollment.countDocuments({
      examSession: id,
      isDeleted:   false,
    });

    return sendSuccess(res, 200, 'Exam session retrieved.', { ...session.toObject(), enrolledCount });
  } catch (err) {
    console.error('❌ getSession:', err);
    return sendError(res, 500, 'Failed to retrieve exam session.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

const updateSession = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid session ID.');

    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const session = await ExamSession.findOne({ _id: id, ...campusFilter, isDeleted: false });
    if (!session) return sendNotFound(res, 'Exam session');
    if (session.status !== 'DRAFT') {
      return sendError(res, 400, 'Only DRAFT sessions can be updated.');
    }

    const IMMUTABLE = ['_id', 'schoolCampus', 'status', 'createdBy', 'createdAt', 'publishedAt', 'completedAt'];
    const updates   = { ...req.body, updatedBy: req.user.id };
    IMMUTABLE.forEach((f) => delete updates[f]);

    const updated = await ExamSession.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    return sendSuccess(res, 200, 'Exam session updated.', updated);
  } catch (err) {
    console.error('❌ updateSession:', err);
    return sendError(res, 500, 'Failed to update exam session.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

const deleteSession = async (req, res) => {
  try {
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

// ─── Status-machine helpers ───────────────────────────────────────────────────

const _transition = async (req, res, { fromStatuses, toStatus, extraUpdates = {}, requiredBody = [] }) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid session ID.');

  const campusFilter = getCampusFilter(req, res);
  if (!campusFilter) return;

  const session = await ExamSession.findOne({ _id: id, ...campusFilter, isDeleted: false });
  if (!session) return sendNotFound(res, 'Exam session');

  if (!fromStatuses.includes(session.status)) {
    return sendError(
      res,
      400,
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
    const updated = await _transition(req, res, {
      fromStatuses: ['DRAFT'],
      toStatus:     'SCHEDULED',
    });
    if (!updated) return;
    return sendSuccess(res, 200, 'Session submitted for review.', updated);
  } catch (err) {
    console.error('❌ submitSession:', err);
    return sendError(res, 500, 'Failed to submit session.');
  }
};

const approveSession = async (req, res) => {
  try {
    if (!isManagerRole(req.user.role)) return sendError(res, 403, 'Managers only.');
    const updated = await _transition(req, res, {
      fromStatuses: ['DRAFT'],
      toStatus:     'SCHEDULED',
    });
    if (!updated) return;
    return sendSuccess(res, 200, 'Session approved.', updated);
  } catch (err) {
    console.error('❌ approveSession:', err);
    return sendError(res, 500, 'Failed to approve session.');
  }
};

const publishSession = async (req, res) => {
  try {
    if (!isManagerRole(req.user.role)) return sendError(res, 403, 'Managers only.');
    const updated = await _transition(req, res, {
      fromStatuses: ['DRAFT'],
      toStatus:     'SCHEDULED',
      extraUpdates: { publishedAt: new Date() },
    });
    if (!updated) return;
    return sendSuccess(res, 200, 'Session published.', updated);
  } catch (err) {
    console.error('❌ publishSession:', err);
    return sendError(res, 500, 'Failed to publish session.');
  }
};

const startSession = async (req, res) => {
  try {
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

const completeSession = async (req, res) => {
  try {
    const updated = await _transition(req, res, {
      fromStatuses: ['ONGOING'],
      toStatus:     'COMPLETED',
      extraUpdates: { completedAt: new Date() },
    });
    if (!updated) return;

    // Dispatch async analytics computation
    const { examAnalyticsWorker } = require('../../services/exam_analytics.worker');
    examAnalyticsWorker.emit('examAnalytics:compute', updated._id.toString());

    return sendSuccess(res, 200, 'Session completed.', updated);
  } catch (err) {
    console.error('❌ completeSession:', err);
    return sendError(res, 500, 'Failed to complete session.');
  }
};

const cancelSession = async (req, res) => {
  try {
    const updated = await _transition(req, res, {
      fromStatuses:  ['DRAFT', 'SCHEDULED', 'ONGOING'],
      toStatus:      'CANCELLED',
      requiredBody:  ['reason'],
      extraUpdates:  { cancellationReason: req.body.reason },
    });
    if (!updated) return;
    return sendSuccess(res, 200, 'Session cancelled.', updated);
  } catch (err) {
    console.error('❌ cancelSession:', err);
    return sendError(res, 500, 'Failed to cancel session.');
  }
};

const postponeSession = async (req, res) => {
  try {
    const { startTime, endTime, reason } = req.body;
    if (!startTime || !endTime || !reason) {
      return sendError(res, 400, 'startTime, endTime and reason are required.');
    }
    const updated = await _transition(req, res, {
      fromStatuses: ['SCHEDULED'],
      toStatus:     'POSTPONED',
      extraUpdates: { startTime, endTime, postponeReason: reason },
    });
    if (!updated) return;
    return sendSuccess(res, 200, 'Session postponed.', updated);
  } catch (err) {
    console.error('❌ postponeSession:', err);
    return sendError(res, 500, 'Failed to postpone session.');
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
  approveSession,
  publishSession,
  startSession,
  completeSession,
  cancelSession,
  postponeSession,
};
