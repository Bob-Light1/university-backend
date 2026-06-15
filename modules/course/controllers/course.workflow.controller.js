'use strict';

/**
 * @file course.workflow.controller.js
 * @description Approval workflow and versioning for the course catalog.
 *
 *  Endpoints handled:
 *  ─────────────────────────────────────────────────────────────────
 *  PATCH  /api/courses/:id/submit       → submitForReview
 *  PATCH  /api/courses/:id/approve      → approveCourse
 *  PATCH  /api/courses/:id/reject       → rejectCourse
 *  POST   /api/courses/:id/new-version  → createNewVersion
 *
 *  Transition table:
 *  ─────────────────────────────────────────────────────────────────
 *  DRAFT | REJECTED → PENDING_REVIEW   (submit)
 *  PENDING_REVIEW   → APPROVED         (approve)
 *  PENDING_REVIEW   → REJECTED         (reject, note ≥ 10 chars)
 *
 *  Versioning (createNewVersion):
 *  ─────────────────────────────────────────────────────────────────
 *  Clone APPROVED → new DRAFT (version + 1). Les deux écritures (retrait de
 *  l'ancienne latest + insertion) sont enveloppées dans une transaction Mongo,
 *  possédée par course.repository.cloneAsNewVersion.
 */

const { APPROVAL_STATUS } = require('../course.model');
const courseRepo = require('../course.repository');

const {
  asyncHandler,
  sendSuccess,
  sendError,
  sendNotFound,
  sendConflict,
} = require('../../../shared/utils/response-helpers');

const { isValidObjectId } = require('../../../shared/utils/validation-helpers');

// ─── VALID TRANSITION GUARD ───────────────────────────────────────────────────

const ALLOWED_TRANSITIONS = Object.freeze({
  [APPROVAL_STATUS.DRAFT]:          [APPROVAL_STATUS.PENDING_REVIEW],
  [APPROVAL_STATUS.REJECTED]:       [APPROVAL_STATUS.PENDING_REVIEW],
  [APPROVAL_STATUS.PENDING_REVIEW]: [APPROVAL_STATUS.APPROVED, APPROVAL_STATUS.REJECTED],
  [APPROVAL_STATUS.APPROVED]:       [],
});

const isValidTransition = (from, to) =>
  (ALLOWED_TRANSITIONS[from] || []).includes(to);

// ─── SUBMIT FOR REVIEW ────────────────────────────────────────────────────────

/**
 * PATCH /api/courses/:id/submit
 * Transition: DRAFT | REJECTED → PENDING_REVIEW.
 */
const submitForReview = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid course ID.');

  const current = await courseRepo.findActiveByIdLean(id);
  if (!current) return sendNotFound(res, 'Course');

  if (!isValidTransition(current.approvalStatus, APPROVAL_STATUS.PENDING_REVIEW)) {
    return sendError(
      res,
      400,
      `Cannot submit a course with status '${current.approvalStatus}'. Must be DRAFT or REJECTED.`,
    );
  }

  const course = await courseRepo.applyStatusTransition(id, {
    newStatus: APPROVAL_STATUS.PENDING_REVIEW,
    historyEntry: {
      status:  APPROVAL_STATUS.PENDING_REVIEW,
      note:    req.body.note?.trim() || 'Submitted for review',
      actor:   req.user.id,
      actedAt: new Date(),
    },
  });
  if (!course) return sendNotFound(res, 'Course');

  return sendSuccess(res, 200, 'Course submitted for review.', course);
});

// ─── APPROVE ──────────────────────────────────────────────────────────────────

/**
 * PATCH /api/courses/:id/approve
 * Transition: PENDING_REVIEW → APPROVED.
 */
const approveCourse = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid course ID.');

  const current = await courseRepo.findActiveByIdLean(id);
  if (!current) return sendNotFound(res, 'Course');

  if (!isValidTransition(current.approvalStatus, APPROVAL_STATUS.APPROVED)) {
    return sendError(
      res,
      400,
      `Cannot approve a course with status '${current.approvalStatus}'. Must be PENDING_REVIEW.`,
    );
  }

  const course = await courseRepo.applyStatusTransition(id, {
    newStatus: APPROVAL_STATUS.APPROVED,
    historyEntry: {
      status:  APPROVAL_STATUS.APPROVED,
      note:    req.body.note?.trim() || 'Approved',
      actor:   req.user.id,
      actedAt: new Date(),
    },
  });
  if (!course) return sendNotFound(res, 'Course');

  return sendSuccess(res, 200, 'Course approved successfully.', course);
});

// ─── REJECT ───────────────────────────────────────────────────────────────────

/**
 * PATCH /api/courses/:id/reject
 * Transition: PENDING_REVIEW → REJECTED.
 * Body: { note: string (min 10 chars, required) }
 */
const rejectCourse = asyncHandler(async (req, res) => {
  const { id }  = req.params;
  const note    = req.body.note?.trim();

  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid course ID.');

  // Rejection note is mandatory and must be meaningful
  if (!note || note.length < 10) {
    return sendError(res, 400, 'A rejection note of at least 10 characters is required.');
  }
  if (note.length > 500) {
    return sendError(res, 400, 'Rejection note must not exceed 500 characters.');
  }

  const current = await courseRepo.findActiveByIdLean(id);
  if (!current) return sendNotFound(res, 'Course');

  if (!isValidTransition(current.approvalStatus, APPROVAL_STATUS.REJECTED)) {
    return sendError(
      res,
      400,
      `Cannot reject a course with status '${current.approvalStatus}'. Must be PENDING_REVIEW.`,
    );
  }

  const course = await courseRepo.applyStatusTransition(id, {
    newStatus: APPROVAL_STATUS.REJECTED,
    historyEntry: {
      status:  APPROVAL_STATUS.REJECTED,
      note,
      actor:   req.user.id,
      actedAt: new Date(),
    },
  });
  if (!course) return sendNotFound(res, 'Course');

  return sendSuccess(res, 200, 'Course rejected.', course);
});

// ─── CREATE NEW VERSION ───────────────────────────────────────────────────────

/**
 * POST /api/courses/:id/new-version
 * Clone an APPROVED course into a new DRAFT at version + 1.
 *
 * @body {boolean} [copyResources=true]
 *   When false, the new draft is created without the parent's resources array.
 *
 * Atomicité : la transaction (retrait de l'ancienne latest + insertion) est
 * gérée par course.repository.cloneAsNewVersion.
 */
const createNewVersion = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid course ID.');

  // copyResources defaults to true — explicit false opt-out only
  const copyResources = req.body.copyResources !== false;

  const original = await courseRepo.findLatestActiveLean(id);
  if (!original) return sendNotFound(res, 'Course (latest version)');

  if (original.approvalStatus !== APPROVAL_STATUS.APPROVED) {
    return sendConflict(
      res,
      `Only APPROVED courses can be versioned. Current status: '${original.approvalStatus}'.`,
    );
  }

  let newCourse;
  try {
    newCourse = await courseRepo.cloneAsNewVersion({ original, actorId: req.user.id, copyResources });
  } catch (err) {
    if (err.statusCode === 409) return sendConflict(res, err.message);
    throw err;
  }

  return sendSuccess(
    res,
    201,
    `New version v${newCourse.version} created as DRAFT.${copyResources ? '' : ' Resources were not copied.'}`,
    newCourse,
  );
});

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  submitForReview,
  approveCourse,
  rejectCourse,
  createNewVersion,
};
