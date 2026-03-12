'use strict';

/**
 * @file course.resources.controller.js
 * @description Resource management and Subject→Course linking.
 *
 *  Endpoints handled:
 *  ─────────────────────────────────────────────────────────────────
 *  POST   /api/courses/:id/resources              → addResource
 *  DELETE /api/courses/:id/resources/:resourceId  → removeResource
 *  PATCH  /api/subject/:id/link-course            → linkSubjectCourse
 *  DELETE /api/subject/:id/link-course            → unlinkSubjectCourse
 *
 *  Security notes:
 *  • CAMPUS_MANAGER may only add resources — `addedBy` is always forced to
 *    req.user.id, and only whitelisted resource fields are accepted.
 *  • linkSubjectCourse enforces: course must be APPROVED + isLatestVersion.
 *  • Cross-level validation: optional. If the caller supplies a `classId` in
 *    the body, the controller verifies that Class.level matches Course.level
 *    and that the Class belongs to the same campus as the Subject.
 *    The Class model in this project does NOT carry a subjects[] array, so
 *    we cannot resolve the Class↔Subject relationship from Subject alone.
 *    Providing classId is therefore the explicit, safe mechanism for level
 *    enforcement without requiring a schedule traversal.
 *
 *  Body: { courseId: string, classId?: string }
 */

const mongoose = require('mongoose');

const { Course, APPROVAL_STATUS } = require('../../models/course.model');
const Subject                      = require('../../models/subject.model');
const Class                        = require('../../models/class.model');

const {
  asyncHandler,
  sendSuccess,
  sendError,
  sendNotFound,
  sendConflict,
  sendForbidden,
} = require('../../utils/responseHelpers');

const { isValidObjectId } = require('../../utils/validationHelpers');
const { RESOURCE_WRITABLE_FIELDS, isManagerRole, pickFields } = require('./course.helper');

// ─── ADD RESOURCE ─────────────────────────────────────────────────────────────

/**
 * POST /api/courses/:id/resources
 * Add a learning resource to a course.
 *
 * Roles: ADMIN, DIRECTOR, CAMPUS_MANAGER.
 * CAMPUS_MANAGER can add resources but cannot modify course fields.
 * `addedBy` is always forced to req.user.id (never trusted from body).
 */
const addResource = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid course ID.');

  const course = await Course.findOne({ _id: id, isDeleted: false });
  if (!course) return sendNotFound(res, 'Course');

  // Whitelist — prevents CAMPUS_MANAGER from injecting other course fields
  const resourceData = pickFields(req.body, RESOURCE_WRITABLE_FIELDS);

  if (!resourceData.title) return sendError(res, 400, 'Resource title is required.');
  if (!resourceData.type)  return sendError(res, 400, 'Resource type is required.');
  if (!resourceData.url)   return sendError(res, 400, 'Resource URL is required.');

  // Basic URL format validation — must be an absolute http/https URL or a non-empty relative path
  const isAbsoluteUrl = /^https?:\/\/.+/i.test(resourceData.url);
  const isRelativePath = /^\/[^\s]+/.test(resourceData.url);
  if (!isAbsoluteUrl && !isRelativePath) {
    return sendError(
      res,
      400,
      'Resource URL must be a valid absolute URL (https://…) or a relative server path (/uploads/…).',
    );
  }

  if ((course.resources || []).length >= 50) {
    return sendConflict(res, 'Maximum of 50 resources per course has been reached.');
  }

  // Force server-side fields — never trust the client for these
  course.resources.push({
    ...resourceData,
    addedBy: req.user.id,
    addedAt: new Date(),
  });

  try {
    await course.save();
  } catch (err) {
    if (err.message.includes('MIME type')) return sendError(res, 400, err.message);
    throw err;
  }

  const addedResource = course.resources[course.resources.length - 1];
  return sendSuccess(res, 201, 'Resource added successfully.', addedResource);
});

// ─── REMOVE RESOURCE ──────────────────────────────────────────────────────────

/**
 * DELETE /api/courses/:id/resources/:resourceId
 * Remove a resource by its subdocument ID.
 * Roles: ADMIN, DIRECTOR only.
 */
const removeResource = asyncHandler(async (req, res) => {
  const { id, resourceId } = req.params;

  if (!isValidObjectId(id))         return sendError(res, 400, 'Invalid course ID.');
  if (!isValidObjectId(resourceId)) return sendError(res, 400, 'Invalid resource ID.');

  const course = await Course.findOne({ _id: id, isDeleted: false });
  if (!course) return sendNotFound(res, 'Course');

  const resourceExists = course.resources.some(
    (r) => r._id.toString() === resourceId,
  );

  if (!resourceExists) return sendNotFound(res, 'Resource');

  course.resources = course.resources.filter(
    (r) => r._id.toString() !== resourceId,
  );

  await course.save();

  return sendSuccess(res, 200, 'Resource removed successfully.');
});

// ─── LINK SUBJECT → COURSE ────────────────────────────────────────────────────

/**
 * PATCH /api/subject/:id/link-course
 * Associate a courseRef to a Subject.
 *
 * Validations:
 *  1. The referenced Course must be APPROVED and isLatestVersion: true.
 *  2. Campus isolation: Subject.schoolCampus must match the user's campus
 *     for non-global roles.
 *  3. Level compatibility (optional but enforced when classId is provided):
 *     Class.level must equal Course.level, AND Class.schoolCampus must equal
 *     Subject.schoolCampus. This is the explicit mechanism for level validation
 *     because Class does not carry a subjects[] array — the Subject↔Class
 *     relationship cannot be resolved from Subject alone without traversing
 *     StudentSchedule / TeacherSchedule, which would be an over-coupled query.
 *     The caller (front-end) supplies the classId of the context class.
 *
 * Body: { courseId: string, classId?: string }
 */
const linkSubjectCourse = asyncHandler(async (req, res) => {
  const { id }              = req.params;
  const { courseId, classId } = req.body;

  if (!isValidObjectId(id))       return sendError(res, 400, 'Invalid subject ID.');
  if (!isValidObjectId(courseId)) return sendError(res, 400, 'Invalid course ID.');

  // classId is optional — validate format only if provided
  if (classId !== undefined && !isValidObjectId(classId)) {
    return sendError(res, 400, 'Invalid class ID format.');
  }

  const subject = await Subject.findById(id);
  if (!subject) return sendNotFound(res, 'Subject');

  // Campus isolation — CAMPUS_MANAGER can only link in their own campus
  if (req.user.role === 'CAMPUS_MANAGER') {
    if (
      req.user.campusId &&
      subject.schoolCampus.toString() !== req.user.campusId.toString()
    ) {
      return sendForbidden(res, 'You can only link courses to subjects in your own campus.');
    }
  }

  // Validate the Course: must be APPROVED and latest version
  const course = await Course.findOne({
    _id:             courseId,
    isDeleted:       false,
    approvalStatus:  APPROVAL_STATUS.APPROVED,
    isLatestVersion: true,
  }).populate('level', 'name');

  if (!course) {
    return sendError(
      res,
      400,
      'The referenced course does not exist or is not APPROVED (latest version only).',
    );
  }

  // ── Optional cross-level validation ────────────────────────────────────────
  // Triggered only when the caller supplies a classId.
  // Verifies: Class.schoolCampus === Subject.schoolCampus AND Class.level === Course.level.
  // This is the only reliable path given that Class has no subjects[] array.
  if (classId) {
    const targetClass = await Class.findOne({
      _id:          classId,
      schoolCampus: subject.schoolCampus,   // correct field name on Class model
    })
      .select('className level schoolCampus')
      .populate('level', 'name')
      .lean();

    if (!targetClass) {
      return sendError(
        res,
        400,
        'The provided class does not exist or does not belong to the same campus as the subject.',
      );
    }

    // Compare Class.level with Course.level
    if (
      targetClass.level &&
      course.level &&
      targetClass.level._id.toString() !== course.level._id.toString()
    ) {
      return sendConflict(
        res,
        `Course level (${course.level.name}) is incompatible with the class level (${targetClass.level.name || 'unknown'}) of class "${targetClass.className}".`,
      );
    }
  }

  subject.courseRef = courseId;
  await subject.save();

  return sendSuccess(res, 200, 'Course linked to subject successfully.', {
    subjectId:   subject._id,
    courseRef:   course._id,
    courseCode:  course.courseCode,
    courseTitle: course.title,
  });
});

// ─── UNLINK SUBJECT → COURSE ──────────────────────────────────────────────────

/**
 * DELETE /api/subject/:id/link-course
 * Remove the courseRef from a Subject.
 * Roles: ADMIN, DIRECTOR, CAMPUS_MANAGER.
 */
const unlinkSubjectCourse = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid subject ID.');

  const subject = await Subject.findById(id);
  if (!subject) return sendNotFound(res, 'Subject');

  // Campus isolation for CAMPUS_MANAGER
  if (req.user.role === 'CAMPUS_MANAGER') {
    if (
      req.user.campusId &&
      subject.schoolCampus.toString() !== req.user.campusId.toString()
    ) {
      return sendForbidden(res, 'You can only unlink courses from subjects in your own campus.');
    }
  }

  if (!subject.courseRef) {
    return sendError(res, 400, 'This subject has no linked course.');
  }

  subject.courseRef = null;
  await subject.save();

  return sendSuccess(res, 200, 'Course unlinked from subject successfully.');
});

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  addResource,
  removeResource,
  linkSubjectCourse,
  unlinkSubjectCourse,
};