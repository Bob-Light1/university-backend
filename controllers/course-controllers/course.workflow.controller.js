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
 *  Clone APPROVED → new DRAFT (version + 1).
 *  The two writes (mark old isLatestVersion: false, insert new) are
 *  wrapped in a MongoDB session for atomicity.
 */

const mongoose = require('mongoose');

const { Course, APPROVAL_STATUS } = require('../../models/course.model');

const {
  asyncHandler,
  sendSuccess,
  sendError,
  sendNotFound,
  sendConflict,
} = require('../../utils/responseHelpers');

const { isValidObjectId } = require('../../utils/validationHelpers');
const { COURSE_POPULATE }  = require('./course.helper');

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

  const course = await Course.findOne({ _id: id, isDeleted: false });
  if (!course) return sendNotFound(res, 'Course');

  if (!isValidTransition(course.approvalStatus, APPROVAL_STATUS.PENDING_REVIEW)) {
    return sendError(
      res,
      400,
      `Cannot submit a course with status '${course.approvalStatus}'. Must be DRAFT or REJECTED.`,
    );
  }

  course.approvalStatus = APPROVAL_STATUS.PENDING_REVIEW;
  course.approvalHistory.push({
    status:  APPROVAL_STATUS.PENDING_REVIEW,
    note:    req.body.note?.trim() || 'Submitted for review',
    actor:   req.user.id,
    actedAt: new Date(),
  });

  await course.save();
  await course.populate(COURSE_POPULATE.DETAIL);

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

  const course = await Course.findOne({ _id: id, isDeleted: false });
  if (!course) return sendNotFound(res, 'Course');

  if (!isValidTransition(course.approvalStatus, APPROVAL_STATUS.APPROVED)) {
    return sendError(
      res,
      400,
      `Cannot approve a course with status '${course.approvalStatus}'. Must be PENDING_REVIEW.`,
    );
  }

  course.approvalStatus = APPROVAL_STATUS.APPROVED;
  course.approvalHistory.push({
    status:  APPROVAL_STATUS.APPROVED,
    note:    req.body.note?.trim() || 'Approved',
    actor:   req.user.id,
    actedAt: new Date(),
  });

  await course.save();
  await course.populate(COURSE_POPULATE.DETAIL);

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

  const course = await Course.findOne({ _id: id, isDeleted: false });
  if (!course) return sendNotFound(res, 'Course');

  if (!isValidTransition(course.approvalStatus, APPROVAL_STATUS.REJECTED)) {
    return sendError(
      res,
      400,
      `Cannot reject a course with status '${course.approvalStatus}'. Must be PENDING_REVIEW.`,
    );
  }

  course.approvalStatus = APPROVAL_STATUS.REJECTED;
  course.approvalHistory.push({
    status:  APPROVAL_STATUS.REJECTED,
    note,
    actor:   req.user.id,
    actedAt: new Date(),
  });

  await course.save();
  await course.populate(COURSE_POPULATE.DETAIL);

  return sendSuccess(res, 200, 'Course rejected.', course);
});

// ─── CREATE NEW VERSION ───────────────────────────────────────────────────────

/**
 * POST /api/courses/:id/new-version
 * Clone an APPROVED course into a new DRAFT at version + 1.
 *
 * @body {boolean} [copyResources=true]
 *   When false, the new draft is created without the parent's resources array.
 *   Useful when the resource set is large or entirely version-specific.
 *   Defaults to true for backward compatibility.
 *
 * Atomicity guarantee:
 *  Step 1 — mark old document isLatestVersion: false
 *  Step 2 — create new document (version + 1, DRAFT)
 * Both steps run inside a MongoDB session (withTransaction).
 * A crash between the two steps will automatically roll back.
 */
const createNewVersion = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid course ID.');

  // copyResources defaults to true — explicit false opt-out only
  const copyResources = req.body.copyResources !== false;

  // Load outside session for a quick 404 check
  const original = await Course.findOne({
    _id:             id,
    isDeleted:       false,
    isLatestVersion: true,
  }).lean();

  if (!original) return sendNotFound(res, 'Course (latest version)');

  if (original.approvalStatus !== APPROVAL_STATUS.APPROVED) {
    return sendConflict(
      res,
      `Only APPROVED courses can be versioned. Current status: '${original.approvalStatus}'.`,
    );
  }

  // ── Atomic transaction ──────────────────────────────────────────────────────
  const dbSession = await mongoose.startSession();
  let newCourse;

  try {
    await dbSession.withTransaction(async () => {
      // Re-verify inside the transaction — guards against a concurrent approve/reject
      // that would have changed the status between the outer check and this write.
      const locked = await Course.findOne(
        { _id: original._id, approvalStatus: APPROVAL_STATUS.APPROVED, isLatestVersion: true },
        null,
        { session: dbSession },
      ).lean();

      if (!locked) {
        throw Object.assign(
          new Error('Course status changed concurrently. Please refresh and retry.'),
          { statusCode: 409 },
        );
      }

      // Step 1 — retire the current latest version
      await Course.findByIdAndUpdate(
        original._id,
        { isLatestVersion: false },
        { session: dbSession },
      );

      // Step 2 — build the new draft (omit Mongoose-managed fields)
      const {
        _id, __v, createdAt, updatedAt,
        slug,                // will be regenerated by pre('validate')
        approvalStatus,      // reset to DRAFT
        approvalHistory,     // fresh history for new version
        isLatestVersion,     // set to true
        version,
        resources,           // conditionally copied — see copyResources flag
        ...cloneData
      } = original;

      // Build the initial approval history entry, noting resource copy decision
      const initNote = copyResources
        ? `New version v${version + 1} created from v${version} (resources copied)`
        : `New version v${version + 1} created from v${version} (resources not copied)`;

      const [created] = await Course.create(
        [
          {
            ...cloneData,
            // Conditionally carry forward parent resources
            resources:       copyResources ? (resources || []) : [],
            version:         version + 1,
            parentCourseId:  original._id,
            isLatestVersion: true,
            approvalStatus:  APPROVAL_STATUS.DRAFT,
            approvalHistory: [
              {
                status:  APPROVAL_STATUS.DRAFT,
                note:    initNote,
                actor:   req.user.id,
                actedAt: new Date(),
              },
            ],
            createdBy: req.user.id,
          },
        ],
        { session: dbSession },
      );

      newCourse = created;
    });
  } catch (err) {
    if (err.statusCode === 409) return sendConflict(res, err.message);
    throw err;
  } finally {
    await dbSession.endSession();
  }

  await newCourse.populate(COURSE_POPULATE.DETAIL);

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