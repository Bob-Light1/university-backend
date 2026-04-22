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

const ExamGrading = require('../../models/exam-models/examGrading.model');
const ExamAppeal  = require('../../models/exam-models/examAppeal.model');
const ExamSession = require('../../models/exam-models/examSession.model');
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
  parsePagination,
} = require('./exam.helper');
const examConfig = require('../../configs/exam.config');

// ─── Submit appeal ────────────────────────────────────────────────────────────

const submitAppeal = async (req, res) => {
  try {
    const { gradingId, reason, attachments } = req.body;

    if (!isValidObjectId(gradingId)) return sendError(res, 400, 'Valid gradingId is required.');
    if (!reason || reason.length < 20) {
      return sendError(res, 400, 'reason must be at least 20 characters.');
    }

    const grading = await ExamGrading.findOne({ _id: gradingId, isDeleted: false });
    if (!grading) return sendNotFound(res, 'Grading');
    if (grading.status !== 'PUBLISHED') {
      return sendError(res, 400, 'Appeals can only be filed on PUBLISHED grades.');
    }
    if (grading.student.toString() !== req.user.id) {
      return sendError(res, 403, 'You can only appeal your own grade.');
    }

    // Compute deadline
    const deadlineAt = new Date(
      grading.publishedAt.getTime() +
      examConfig.appealWindowDays * 24 * 60 * 60 * 1000
    );

    if (new Date() > deadlineAt) {
      return sendError(res, 400, `The appeal window has closed (deadline was ${deadlineAt.toISOString()}).`);
    }

    const existing = await ExamAppeal.findOne({ grading: gradingId, student: req.user.id, isDeleted: false });
    if (existing) {
      return sendError(res, 409, 'You have already submitted an appeal for this grade.');
    }

    const session = await ExamSession.findById(grading.examSession);

    const appeal = await ExamAppeal.create({
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

    const [appeals, total] = await Promise.all([
      ExamAppeal.find(match)
        .populate('student', 'firstName lastName matricule')
        .populate({ path: 'grading', select: 'normalizedScore finalScore status examSession' })
        .populate('reviewedBy', 'firstName lastName role')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ExamAppeal.countDocuments(match),
    ]);

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

    const appeal = await ExamAppeal.findOne({ _id: id, ...campusFilter, isDeleted: false });
    if (!appeal) return sendNotFound(res, 'Appeal');
    if (appeal.status !== 'PENDING') {
      return sendError(res, 400, 'Only PENDING appeals can be taken under review.');
    }

    if (new Date() > new Date(appeal.deadlineAt)) {
      // Auto-reject expired appeals
      appeal.status     = 'REJECTED';
      appeal.resolution = 'Automatically rejected: deadline exceeded.';
      appeal.resolvedAt = new Date();
      await appeal.save();
      return sendError(res, 400, 'Appeal deadline has passed. Automatically rejected.');
    }

    const updated = await ExamAppeal.findByIdAndUpdate(
      id,
      { $set: { status: 'UNDER_REVIEW', reviewedBy: req.user.id, updatedBy: req.user.id } },
      { new: true }
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
    if (decision === 'RESOLVED' && newScore == null) {
      return sendError(res, 400, 'newScore is required when resolving an appeal.');
    }

    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const appeal = await ExamAppeal.findOne({ _id: id, ...campusFilter, isDeleted: false });
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
      await ExamGrading.findByIdAndUpdate(appeal.grading, {
        $set: {
          finalScore:  newScore,
          updatedBy:   req.user.id,
        },
      });
    }

    const updated = await ExamAppeal.findByIdAndUpdate(id, { $set: updates }, { new: true })
      .populate('student', 'firstName lastName')
      .populate('grading', 'normalizedScore finalScore');

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
