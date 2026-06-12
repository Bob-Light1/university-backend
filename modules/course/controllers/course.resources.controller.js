'use strict';

/**
 * @file course.resources.controller.js
 * @description Resource management on courses.
 *
 *  Endpoints handled:
 *  ─────────────────────────────────────────────────────────────────
 *  POST   /api/courses/:id/resources              → addResource
 *  DELETE /api/courses/:id/resources/:resourceId  → removeResource
 *
 *  (Le lien Subject→Course a été déplacé vers
 *  modules/subject/controllers/subject.course-link.controller.js — chantier 20b.)
 *
 *  Security notes:
 *  • CAMPUS_MANAGER may only add resources — `addedBy` is always forced to
 *    req.user.id, and only whitelisted resource fields are accepted.
 */

const { Course } = require('../course.model');

const {
  asyncHandler,
  sendSuccess,
  sendError,
  sendNotFound,
  sendConflict,
} = require('../../../shared/utils/response-helpers');

const { isValidObjectId } = require('../../../utils/validation-helpers');
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

  const course = await Course.findOne({ _id: id, status: { $ne: 'archived' } });
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

  const course = await Course.findOne({ _id: id, status: { $ne: 'archived' } });
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

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  addResource,
  removeResource,
};