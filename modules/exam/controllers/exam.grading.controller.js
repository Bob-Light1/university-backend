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

const repo = require('../exam.repository');
const {
  sendSuccess,
  sendError,
  sendNotFound,
  sendCreated,
  sendPaginated,
} = require('../../../shared/utils/response-helpers');
const { isValidObjectId } = require('../../../shared/utils/validation-helpers');
const {
  getCampusFilter,
  isManagerRole,
  parsePagination,
} = require('./exam.helper');
const { examAnalyticsWorker } = require('../exam-analytics.worker');

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

    const { docs: gradings, total } = await repo.paginateGradings(match, { skip, limit });

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

    const grading = await repo.findGradingDetailed({ _id: id, ...campusFilter, isDeleted: false });

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

    const session = await repo.findSessionByFilter({ _id: sessionId, ...campusFilter, isDeleted: false });
    if (!session) return sendNotFound(res, 'Exam session');

    const { page, limit, skip } = parsePagination(req.query);

    const match = {
      examSession: sessionId,
      status:      { $in: ['SUBMITTED'] },
      isDeleted:   false,
    };

    // Teachers see only submissions assigned to them via existing ExamGrading entries
    if (req.user.role === 'TEACHER') {
      const assigned = await repo.distinctGradedSubmissions(sessionId, req.user.id);
      match._id = { $in: assigned };
    }

    const { docs: submissions, total } = await repo.paginateSubmissions(match, { skip, limit });

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

    const submission = await repo.findSubmissionById(submissionId);
    if (!submission) return sendNotFound(res, 'Submission');
    if (submission.status === 'IN_PROGRESS') {
      return sendError(res, 400, 'Cannot grade an in-progress submission.');
    }

    const session = await repo.findSessionByFilter({
      _id:       submission.examSession,
      ...campusFilter,
      isDeleted: false,
    });
    if (!session) return sendNotFound(res, 'Exam session');

    if (score < 0 || score > session.maxScore) {
      return sendError(res, 400, `Score must be between 0 and ${session.maxScore}.`);
    }

    const existing = await repo.findGradingBySubmission(submissionId);
    if (existing && existing.status !== 'PENDING') {
      return sendError(res, 409, 'This submission has already been graded.');
    }

    const grading = existing
      ? await repo.updateGradingById(
          existing._id,
          {
            score, rubricScores, annotations, graderFeedback,
            isBlindGrading: isBlindGrading ?? false,
            status:    'GRADED',
            updatedBy: req.user.id,
          },
          { new: true, runValidators: true }
        )
      : await repo.createGrading({
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

    await repo.setSubmissionStatus(submissionId, 'GRADED');

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

    const grading = await repo.findGradingById(id);
    if (!grading) return sendNotFound(res, 'Grading');
    if (grading.status === 'PUBLISHED') {
      return sendError(res, 400, 'Published gradings cannot be modified.');
    }

    const ALLOWED = ['score', 'rubricScores', 'annotations', 'graderFeedback'];
    const updates = { updatedBy: req.user.id };
    ALLOWED.forEach((f) => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

    const updated = await repo.updateGradingById(id, updates, { new: true, runValidators: true });
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

    const grading = await repo.findGradingById(id);
    if (!grading) return sendNotFound(res, 'Grading');
    if (!['GRADED'].includes(grading.status)) {
      return sendError(res, 400, 'Second grader can only be assigned to GRADED entries.');
    }

    const updated = await repo.updateGradingById(
      id,
      { secondGrader: teacherId, updatedBy: req.user.id },
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

    const grading = await repo.findGradingById(id);
    if (!grading) return sendNotFound(res, 'Grading');
    if (grading.status !== 'GRADED') {
      return sendError(res, 400, 'Only GRADED entries accept a second score.');
    }
    if (grading.secondGrader?.toString() !== req.user.id && !isManagerRole(req.user.role)) {
      return sendError(res, 403, 'Only the assigned second grader can submit a second score.');
    }

    const updated = await repo.updateGradingById(
      id,
      { secondScore, status: 'DOUBLE_GRADED', updatedBy: req.user.id },
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

    const grading = await repo.findGradingById(id);
    if (!grading) return sendNotFound(res, 'Grading');
    if (!grading.needsMediation) {
      return sendError(res, 400, 'This grading does not require mediation.');
    }

    const updated = await repo.updateGradingById(
      id,
      { mediatorScore, status: 'MEDIATED', updatedBy: req.user.id },
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

    const session = await repo.findSessionByFilter({ _id: sessionId, ...campusFilter, isDeleted: false });
    if (!session) return sendNotFound(res, 'Exam session');

    const result = await repo.publishSessionGradings(sessionId, {
      status: 'PUBLISHED', publishedAt: new Date(), updatedBy: req.user.id,
    });

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
