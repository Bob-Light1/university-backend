'use strict';

/**
 * @file exam_appeal_controller.js
 * @description Student appeals workflow — submit, review, resolve/reject.
 *
 *  Routes (all prefixed /api/examination):
 *    POST   /appeals                → submitAppeal    [STUDENT]
 *    GET    /appeals                → listAppeals     [MANAGER, TEACHER]
 *    PATCH  /appeals/:id/review     → reviewAppeal    [MANAGER, TEACHER]
 *    PATCH  /appeals/:id/resolve    → resolveAppeal   [MANAGER, TEACHER]
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
  parsePagination,
} = require('./exam.helper');
const examConfig = require('../exam.config');

// ─── Submit appeal ────────────────────────────────────────────────────────────

const submitAppeal = async (req, res) => {
  try {
    const { gradingId, reason, attachments } = req.body;

    if (!isValidObjectId(gradingId)) return sendError(res, 400, 'Valid gradingId is required.');
    if (!reason || reason.length < 20) {
      return sendError(res, 400, 'reason must be at least 20 characters.');
    }

    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const grading = await repo.findGradingById({ _id: gradingId, ...campusFilter });
    if (!grading) return sendNotFound(res, 'Grading');
    if (grading.status !== 'PUBLISHED') {
      return sendError(res, 400, 'Appeals can only be filed on PUBLISHED grades.');
    }
    if (grading.student.toString() !== req.user.id) {
      return sendError(res, 403, 'You can only appeal your own grade.');
    }
    if (!grading.publishedAt) {
      return sendError(res, 400, 'This grade has no publication date; appeal window cannot be determined.');
    }

    // Compute deadline
    const deadlineAt = new Date(
      grading.publishedAt.getTime() +
      examConfig.appealWindowDays * 24 * 60 * 60 * 1000
    );

    if (new Date() > deadlineAt) {
      return sendError(res, 400, `The appeal window has closed (deadline was ${deadlineAt.toISOString()}).`);
    }

    const existing = await repo.findAppealByGradingAndStudent(gradingId, req.user.id);
    if (existing) {
      return sendError(res, 409, 'You have already submitted an appeal for this grade.');
    }

    const session = await repo.findSessionById(grading.examSession);

    const appeal = await repo.createAppeal({
      schoolCampus: session?.schoolCampus,
      grading:      gradingId,
      student:      req.user.id,
      reason,
      attachments:  attachments || [],
      deadlineAt,
      status:       'PENDING',
      createdBy:    req.user.id,
    });

    return sendCreated(res, 'Appeal submitted.', appeal);
  } catch (err) {
    console.error('❌ submitAppeal:', err);
    return sendError(res, 500, 'Failed to submit appeal.');
  }
};

// ─── List appeals ─────────────────────────────────────────────────────────────

const listAppeals = async (req, res) => {
  try {
    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const { page, limit, skip } = parsePagination(req.query);
    const match = { ...campusFilter, isDeleted: false };
    if (req.query.status) match.status = req.query.status;

    // Students see only their own appeals
    if (req.user.role === 'STUDENT') match.student = req.user.id;

    const { docs: appeals, total } = await repo.paginateAppeals(match, { skip, limit });

    return sendPaginated(res, 200, 'Appeals retrieved.', appeals, { total, page, limit });
  } catch (err) {
    console.error('❌ listAppeals:', err);
    return sendError(res, 500, 'Failed to retrieve appeals.');
  }
};

// ─── Review ───────────────────────────────────────────────────────────────────

const reviewAppeal = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid appeal ID.');

    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const appeal = await repo.findAppealByFilter({ _id: id, ...campusFilter, isDeleted: false });
    if (!appeal) return sendNotFound(res, 'Appeal');
    if (appeal.status !== 'PENDING') {
      return sendError(res, 400, 'Only PENDING appeals can be taken under review.');
    }

    if (new Date() > new Date(appeal.deadlineAt)) {
      // Auto-reject expired appeals
      appeal.status     = 'REJECTED';
      appeal.resolution = 'Automatically rejected: deadline exceeded.';
      appeal.resolvedAt = new Date();
      await repo.saveAppealDoc(appeal);
      return sendError(res, 400, 'Appeal deadline has passed. Automatically rejected.');
    }

    const updated = await repo.updateAppealById(
      id,
      { status: 'UNDER_REVIEW', reviewedBy: req.user.id, updatedBy: req.user.id }
    );

    return sendSuccess(res, 200, 'Appeal is now under review.', updated);
  } catch (err) {
    console.error('❌ reviewAppeal:', err);
    return sendError(res, 500, 'Failed to update appeal status.');
  }
};

// ─── Resolve / reject ─────────────────────────────────────────────────────────

const resolveAppeal = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid appeal ID.');

    const { decision, resolution, newScore } = req.body;
    if (!['RESOLVED', 'REJECTED'].includes(decision)) {
      return sendError(res, 400, "decision must be 'RESOLVED' or 'REJECTED'.");
    }
    if (!resolution) return sendError(res, 400, 'resolution is required.');
    // newScore is optional on RESOLVED: an appeal can be upheld without changing
    // the score. When provided, it is propagated to the grading's finalScore.

    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const appeal = await repo.findAppealByFilter({ _id: id, ...campusFilter, isDeleted: false });
    if (!appeal) return sendNotFound(res, 'Appeal');
    if (appeal.status !== 'UNDER_REVIEW') {
      return sendError(res, 400, 'Only UNDER_REVIEW appeals can be resolved.');
    }

    const updates = {
      status:     decision,
      resolution,
      resolvedAt: new Date(),
      updatedBy:  req.user.id,
    };
    if (decision === 'RESOLVED' && newScore != null) {
      updates.newScore = newScore;
      // Propagate score change to ExamGrading
      await repo.updateGradingById(appeal.grading, { finalScore: newScore, updatedBy: req.user.id });
    }

    const updated = await repo.updateAppealByIdPopulated(id, updates);

    return sendSuccess(res, 200, `Appeal ${decision.toLowerCase()}.`, updated);
  } catch (err) {
    console.error('❌ resolveAppeal:', err);
    return sendError(res, 500, 'Failed to resolve appeal.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  submitAppeal,
  listAppeals,
  reviewAppeal,
  resolveAppeal,
};
