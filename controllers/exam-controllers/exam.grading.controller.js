'use strict';

/**
 * @file exam.grading.controller.js
 * @description Manual grading, double-blind workflow, mediation, and bulk publication.
 *
 *  Routes (all prefixed /api/examination):
 *    GET   /grading                        → listGradings
 *    POST  /grading                        → gradeSubmission       [TEACHER, MANAGER]  body: { submissionId, score, ... }
 *    POST  /grading/publish                → publishGrades         [MANAGER]           body: { sessionId }
 *    GET   /grading/queue                  → gradingQueue          [TEACHER, MANAGER]  query: sessionId (required)
 *    GET   /grading/:id                    → getGrading
 *    PATCH /grading/:id                    → updateGrading
 *    PATCH /grading/:id/second-grader      → assignSecondGrader    [MANAGER]
 *    PATCH /grading/:id/second-grade       → submitSecondGrade
 *    PATCH /grading/:id/mediate            → mediate               [MANAGER]
 */

const ExamSession    = require('../../models/exam-models/examSession.model');
const ExamSubmission = require('../../models/exam-models/examSubmission.model');
const ExamGrading    = require('../../models/exam-models/examGrading.model');
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
  isManagerRole,
  parsePagination,
} = require('./exam.helper');
const { examAnalyticsWorker } = require('../../services/exam_analytics.worker');

// ─── List gradings ────────────────────────────────────────────────────────────

const listGradings = async (req, res) => {
  try {
    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const { page, limit, skip } = parsePagination(req.query);
    const match = { ...campusFilter, isDeleted: false };

    if (req.query.sessionId)  match.examSession = req.query.sessionId;
    if (req.query.status)     match.status      = req.query.status;
    if (req.query.grader)     match.grader      = req.query.grader;

    // Teachers see only gradings they are assigned to
    if (req.user.role === 'TEACHER') {
      match.$or = [{ grader: req.user.id }, { secondGrader: req.user.id }];
    }

    const [gradings, total] = await Promise.all([
      ExamGrading.find(match)
        .populate('student',     'firstName lastName matricule')
        .populate('grader',      'firstName lastName')
        .populate('secondGrader','firstName lastName')
        .populate('examSession', 'title subject startTime')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ExamGrading.countDocuments(match),
    ]);

    return sendPaginated(res, 200, 'Gradings retrieved.', gradings, { total, page, limit });
  } catch (err) {
    console.error('❌ listGradings:', err);
    return sendError(res, 500, 'Failed to retrieve gradings.');
  }
};

// ─── Get single grading ───────────────────────────────────────────────────────

const getGrading = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid grading ID.');

    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const grading = await ExamGrading.findOne({ _id: id, ...campusFilter, isDeleted: false })
      .populate('student',      'firstName lastName matricule')
      .populate('grader',       'firstName lastName')
      .populate('secondGrader', 'firstName lastName')
      .populate('submission',   'answers submittedAt status')
      .populate('examSession',  'title subject maxScore startTime');

    if (!grading) return sendNotFound(res, 'Grading');

    // Students may only see their own published grading
    if (req.user.role === 'STUDENT') {
      if (grading.student._id.toString() !== req.user.id) {
        return sendError(res, 403, 'You can only view your own grading.');
      }
      if (grading.status !== 'PUBLISHED') {
        return sendError(res, 403, 'Grades are not yet published.');
      }
    }

    return sendSuccess(res, 200, 'Grading retrieved.', grading);
  } catch (err) {
    console.error('❌ getGrading:', err);
    return sendError(res, 500, 'Failed to retrieve grading.');
  }
};

// ─── Grading queue ────────────────────────────────────────────────────────────

const gradingQueue = async (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId || !isValidObjectId(sessionId)) {
      return sendError(res, 400, 'Valid sessionId query parameter is required.');
    }

    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const session = await ExamSession.findOne({ _id: sessionId, ...campusFilter, isDeleted: false });
    if (!session) return sendNotFound(res, 'Exam session');

    const { page, limit, skip } = parsePagination(req.query);

    const match = {
      examSession: sessionId,
      status:      { $in: ['SUBMITTED'] },
      isDeleted:   false,
    };

    // Teachers see only submissions assigned to them via existing ExamGrading entries
    if (req.user.role === 'TEACHER') {
      const assigned = await ExamGrading.find({ examSession: sessionId, grader: req.user.id }).distinct('submission');
      match._id = { $in: assigned };
    }

    const [submissions, total] = await Promise.all([
      ExamSubmission.find(match)
        .populate('student', 'firstName lastName matricule')
        .sort({ submittedAt: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ExamSubmission.countDocuments(match),
    ]);

    return sendPaginated(res, 200, 'Grading queue retrieved.', submissions, { total, page, limit });
  } catch (err) {
    console.error('❌ gradingQueue:', err);
    return sendError(res, 500, 'Failed to retrieve grading queue.');
  }
};

// ─── Grade a submission ───────────────────────────────────────────────────────

const gradeSubmission = async (req, res) => {
  try {
    const { submissionId, score, rubricScores, annotations, graderFeedback, isBlindGrading } = req.body;

    if (!submissionId || !isValidObjectId(submissionId)) {
      return sendError(res, 400, 'Valid submissionId is required in request body.');
    }
    if (score == null) return sendError(res, 400, 'score is required.');

    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const submission = await ExamSubmission.findOne({ _id: submissionId, isDeleted: false });
    if (!submission) return sendNotFound(res, 'Submission');
    if (submission.status === 'IN_PROGRESS') {
      return sendError(res, 400, 'Cannot grade an in-progress submission.');
    }

    const session = await ExamSession.findOne({
      _id:       submission.examSession,
      ...campusFilter,
      isDeleted: false,
    });
    if (!session) return sendNotFound(res, 'Exam session');

    if (score < 0 || score > session.maxScore) {
      return sendError(res, 400, `Score must be between 0 and ${session.maxScore}.`);
    }

    const existing = await ExamGrading.findOne({ submission: submissionId, isDeleted: false });
    if (existing && existing.status !== 'PENDING') {
      return sendError(res, 409, 'This submission has already been graded.');
    }

    const grading = existing
      ? await ExamGrading.findByIdAndUpdate(
          existing._id,
          {
            $set: {
              score, rubricScores, annotations, graderFeedback,
              isBlindGrading: isBlindGrading ?? false,
              status:    'GRADED',
              updatedBy: req.user.id,
            },
          },
          { new: true, runValidators: true }
        )
      : await ExamGrading.create({
          schoolCampus:  campusFilter.schoolCampus || session.schoolCampus,
          submission:    submissionId,
          examSession:   session._id,
          student:       submission.student,
          grader:        req.user.id,
          score,
          maxScore:      session.maxScore,
          rubricScores,
          annotations,
          graderFeedback,
          isBlindGrading: isBlindGrading ?? false,
          status:        'GRADED',
          createdBy:     req.user.id,
        });

    await ExamSubmission.findByIdAndUpdate(submissionId, { status: 'GRADED' });

    return sendCreated(res, 'Grading submitted.', grading);
  } catch (err) {
    console.error('❌ gradeSubmission:', err);
    return sendError(res, 500, 'Failed to grade submission.');
  }
};

// ─── Update grading (before PUBLISHED) ───────────────────────────────────────

const updateGrading = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid grading ID.');

    const grading = await ExamGrading.findOne({ _id: id, isDeleted: false });
    if (!grading) return sendNotFound(res, 'Grading');
    if (grading.status === 'PUBLISHED') {
      return sendError(res, 400, 'Published gradings cannot be modified.');
    }

    const ALLOWED = ['score', 'rubricScores', 'annotations', 'graderFeedback'];
    const updates = { updatedBy: req.user.id };
    ALLOWED.forEach((f) => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

    const updated = await ExamGrading.findByIdAndUpdate(id, { $set: updates }, { new: true, runValidators: true });
    return sendSuccess(res, 200, 'Grading updated.', updated);
  } catch (err) {
    console.error('❌ updateGrading:', err);
    return sendError(res, 500, 'Failed to update grading.');
  }
};

// ─── Assign second grader ─────────────────────────────────────────────────────

const assignSecondGrader = async (req, res) => {
  try {
    if (!isManagerRole(req.user.role)) return sendError(res, 403, 'Managers only.');

    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid grading ID.');

    const { teacherId } = req.body;
    if (!isValidObjectId(teacherId)) return sendError(res, 400, 'Valid teacherId is required.');

    const grading = await ExamGrading.findOne({ _id: id, isDeleted: false });
    if (!grading) return sendNotFound(res, 'Grading');
    if (!['GRADED'].includes(grading.status)) {
      return sendError(res, 400, 'Second grader can only be assigned to GRADED entries.');
    }

    const updated = await ExamGrading.findByIdAndUpdate(
      id,
      { $set: { secondGrader: teacherId, updatedBy: req.user.id } },
      { new: true }
    );
    return sendSuccess(res, 200, 'Second grader assigned.', updated);
  } catch (err) {
    console.error('❌ assignSecondGrader:', err);
    return sendError(res, 500, 'Failed to assign second grader.');
  }
};

// ─── Submit second grade ──────────────────────────────────────────────────────

const submitSecondGrade = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid grading ID.');

    const { secondScore } = req.body;
    if (secondScore == null) return sendError(res, 400, 'secondScore is required.');

    const grading = await ExamGrading.findOne({ _id: id, isDeleted: false });
    if (!grading) return sendNotFound(res, 'Grading');
    if (grading.status !== 'GRADED') {
      return sendError(res, 400, 'Only GRADED entries accept a second score.');
    }
    if (grading.secondGrader?.toString() !== req.user.id && !isManagerRole(req.user.role)) {
      return sendError(res, 403, 'Only the assigned second grader can submit a second score.');
    }

    const updated = await ExamGrading.findByIdAndUpdate(
      id,
      { $set: { secondScore, status: 'DOUBLE_GRADED', updatedBy: req.user.id } },
      { new: true, runValidators: true }
    );
    return sendSuccess(res, 200, 'Second grade submitted.', updated);
  } catch (err) {
    console.error('❌ submitSecondGrade:', err);
    return sendError(res, 500, 'Failed to submit second grade.');
  }
};

// ─── Mediate ──────────────────────────────────────────────────────────────────

const mediate = async (req, res) => {
  try {
    if (!isManagerRole(req.user.role)) return sendError(res, 403, 'Managers only.');

    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid grading ID.');

    const { mediatorScore } = req.body;
    if (mediatorScore == null) return sendError(res, 400, 'mediatorScore is required.');

    const grading = await ExamGrading.findOne({ _id: id, isDeleted: false });
    if (!grading) return sendNotFound(res, 'Grading');
    if (!grading.needsMediation) {
      return sendError(res, 400, 'This grading does not require mediation.');
    }

    const updated = await ExamGrading.findByIdAndUpdate(
      id,
      { $set: { mediatorScore, status: 'MEDIATED', updatedBy: req.user.id } },
      { new: true, runValidators: true }
    );
    return sendSuccess(res, 200, 'Mediation complete.', updated);
  } catch (err) {
    console.error('❌ mediate:', err);
    return sendError(res, 500, 'Failed to submit mediator score.');
  }
};

// ─── Bulk publish grades ──────────────────────────────────────────────────────

const publishGrades = async (req, res) => {
  try {
    if (!isManagerRole(req.user.role)) return sendError(res, 403, 'Managers only.');

    const { sessionId } = req.body;
    if (!sessionId || !isValidObjectId(sessionId)) {
      return sendError(res, 400, 'Valid sessionId is required in request body.');
    }

    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const session = await ExamSession.findOne({ _id: sessionId, ...campusFilter, isDeleted: false });
    if (!session) return sendNotFound(res, 'Exam session');

    const result = await ExamGrading.updateMany(
      { examSession: sessionId, status: { $in: ['GRADED', 'MEDIATED'] }, isDeleted: false },
      { $set: { status: 'PUBLISHED', publishedAt: new Date(), updatedBy: req.user.id } }
    );

    examAnalyticsWorker.emit('examAnalytics:compute', sessionId);

    return sendSuccess(res, 200, `${result.modifiedCount} grade(s) published.`, {
      sessionId,
      published: result.modifiedCount,
    });
  } catch (err) {
    console.error('❌ publishGrades:', err);
    return sendError(res, 500, 'Failed to publish grades.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  listGradings,
  getGrading,
  gradingQueue,
  gradeSubmission,
  updateGrading,
  assignSecondGrader,
  submitSecondGrade,
  mediate,
  publishGrades,
};
