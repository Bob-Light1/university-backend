'use strict';

/**
 * @file course.crud.controller.js
 * @description CRUD operations for the global course catalog.
 *
 *  Endpoints handled:
 *  ─────────────────────────────────────────────────────────────────
 *  POST   /api/courses                  → createCourse
 *  GET    /api/courses                  → listCourses
 *  GET    /api/courses/code/:courseCode → getCourseByCode
 *  GET    /api/courses/:id              → getCourseById
 *  GET    /api/courses/:id/versions     → getCourseVersions
 *  PUT    /api/courses/:id              → updateCourse
 *  DELETE /api/courses/:id              → softDeleteCourse
 *  PATCH  /api/courses/:id/restore      → restoreCourse
 *
 *  Security notes:
 *  • No schoolCampus field exists on Course — any attempt to inject it is silently
 *    dropped by the field whitelist (pickFields).
 *  • PUT on an APPROVED course with pedagogical fields returns 409.
 *  • softDeleteCourse is blocked while active Subject references exist.
 */

const { APPROVAL_STATUS } = require('../course.model');
const courseRepo = require('../course.repository');
// Lazy requires: subject.course-link consumes the course facade (course ↔ subject cycle)
const subjectService = () => require('../../subject').service;

const {
  asyncHandler,
  sendSuccess,
  sendCreated,
  sendError,
  sendPaginated,
  sendNotFound,
  sendConflict,
  handleDuplicateKeyError,
} = require('../../../shared/utils/response-helpers');

const { isValidObjectId } = require('../../../shared/utils/validation-helpers');

const {
  isGlobalRole,
  COURSE_WRITABLE_FIELDS,
  COURSE_APPROVED_MUTABLE_FIELDS,
  SORT_MAP,
  DEFAULT_SORT,
  parsePositiveInt,
  pickFields,
  hasPedagogicalFields,
  buildCourseFilter,
} = require('./course.helper');

// ─── CREATE ───────────────────────────────────────────────────────────────────

/**
 * POST /api/courses
 * Create a new course at version 1, status DRAFT.
 * Only ADMIN and DIRECTOR may create courses.
 */
const createCourse = asyncHandler(async (req, res) => {
  // Whitelist body — schoolCampus is not a valid Course field and will be dropped
  const payload = pickFields(req.body, COURSE_WRITABLE_FIELDS);

  // Mandatory fields check before hitting Mongoose validation
  if (!payload.courseCode) return sendError(res, 400, 'courseCode is required.');
  if (!payload.title)      return sendError(res, 400, 'title is required.');
  if (!payload.category)   return sendError(res, 400, 'category is required.');
  if (!payload.level)      return sendError(res, 400, 'level is required.');
  if (!isValidObjectId(payload.level)) return sendError(res, 400, 'Invalid level ID format.');

  // Validate prerequisite IDs if provided
  if (Array.isArray(payload.prerequisites)) {
    for (const p of payload.prerequisites) {
      if (!isValidObjectId(p.course)) {
        return sendError(res, 400, `Invalid prerequisite course ID: ${p.course}`);
      }
      // Prevent self-referencing prerequisite
      // (cannot check against _id before Course.create, so skip self-check here —
      //  the BFS pre-save hook will catch cycles; the model unique constraint covers duplicates)
    }

    // Verify all referenced prerequisite courses actually exist in the catalog
    const prereqIds = payload.prerequisites.map((p) => p.course);
    const foundCount = await courseRepo.countExistingActive(prereqIds);
    if (foundCount !== prereqIds.length) {
      return sendError(res, 400, 'One or more prerequisite courses do not exist.');
    }
  }

  try {
    const course = await courseRepo.create({
      ...payload,
      version:         1,
      isLatestVersion: true,
      approvalStatus:  APPROVAL_STATUS.DRAFT,
      createdBy:       req.user.id,
    });

    return sendCreated(res, 'Course created successfully.', course);
  } catch (err) {
    if (err.code === 11000) return handleDuplicateKeyError(res, err);
    if (err.name === 'ValidationError') return sendError(res, 400, err.message);
    throw err;
  }
});

// ─── LIST ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/courses
 * Paginated list with dynamic filters and role-based visibility.
 *
 * Non-global roles (TEACHER, STUDENT, CAMPUS_MANAGER) always receive
 * APPROVED + isLatestVersion: true only.
 *
 * STUDENT role has resources.isPublic === false filtered out.
 */
const listCourses = asyncHandler(async (req, res) => {
  const page  = parsePositiveInt(req.query.page, 1);
  const limit = Math.min(parsePositiveInt(req.query.limit, 20), 100);
  const skip  = (page - 1) * limit;

  // Build filter from query + user role
  const filter = buildCourseFilter(req.query, req.user);

  // isLinked filter — ADMIN / DIRECTOR only
  if (req.query.isLinked !== undefined && isGlobalRole(req.user.role)) {
    const linkedIds = await subjectService().getLinkedCourseRefIds();
    if (req.query.isLinked === 'true') {
      filter._id = { $in: linkedIds };
    } else {
      filter._id = { $nin: linkedIds };
    }
  }

  // Sort
  const sort = SORT_MAP[req.query.sort] || DEFAULT_SORT;

  const { data: courses, total } = await courseRepo.paginateList({ filter, sort, skip, limit });

  // Filter private resources for STUDENT role
  const isStudent = req.user.role === 'STUDENT';
  const data = isStudent
    ? courses.map((c) => ({
        ...c,
        resources: (c.resources || []).filter((r) => r.isPublic !== false),
      }))
    : courses;

  return sendPaginated(res, 200, 'Courses retrieved successfully.', data, {
    total,
    page,
    limit,
  });
});

// ─── GET BY ID ────────────────────────────────────────────────────────────────

/**
 * GET /api/courses/:id
 * Full course detail with syllabus, resources, approval history.
 * TEACHER/STUDENT only see APPROVED courses.
 */
const getCourseById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid course ID.');

  const course = await courseRepo.findActiveByIdDetailed(id);

  if (!course) return sendNotFound(res, 'Course');

  // Non-global roles only see APPROVED
  if (!isGlobalRole(req.user.role) && course.approvalStatus !== APPROVAL_STATUS.APPROVED) {
    return sendNotFound(res, 'Course');
  }

  // Filter private resources for STUDENT
  if (req.user.role === 'STUDENT') {
    course.resources = (course.resources || []).filter((r) => r.isPublic !== false);
  }

  return sendSuccess(res, 200, 'Course retrieved successfully.', course);
});

// ─── GET BY CODE ──────────────────────────────────────────────────────────────

/**
 * GET /api/courses/code/:courseCode
 * Retrieve the latest version of a course by its code.
 */
const getCourseByCode = asyncHandler(async (req, res) => {
  const { courseCode } = req.params;

  const course = await courseRepo.findLatestActiveByCode(courseCode.toUpperCase().trim());

  if (!course) return sendNotFound(res, 'Course');

  // Non-global roles only see APPROVED
  if (!isGlobalRole(req.user.role) && course.approvalStatus !== APPROVAL_STATUS.APPROVED) {
    return sendNotFound(res, 'Course');
  }

  // Filter private resources for STUDENT
  if (req.user.role === 'STUDENT') {
    course.resources = (course.resources || []).filter((r) => r.isPublic !== false);
  }

  return sendSuccess(res, 200, 'Course retrieved successfully.', course);
});

// ─── GET VERSION HISTORY ──────────────────────────────────────────────────────

/**
 * GET /api/courses/:id/versions
 * Full version history chain for a course (ADMIN / DIRECTOR only).
 * Returns all versions of the same courseCode, sorted by version desc.
 *
 * @query page  {number} - Page number (default: 1)
 * @query limit {number} - Items per page (default: 10, max: 50)
 */
const getCourseVersions = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid course ID.');

  // Find the reference course to get the courseCode
  const ref = await courseRepo.findCodeById(id);
  if (!ref) return sendNotFound(res, 'Course');

  const page  = parsePositiveInt(req.query.page, 1);
  const limit = Math.min(parsePositiveInt(req.query.limit, 10), 50);
  const skip  = (page - 1) * limit;

  const { data: versions, total } = await courseRepo.paginateVersions(ref.courseCode, { skip, limit });

  return sendPaginated(res, 200, 'Version history retrieved successfully.', versions, {
    total,
    page,
    limit,
  });
});

// ─── UPDATE ───────────────────────────────────────────────────────────────────

/**
 * PUT /api/courses/:id
 * Update a DRAFT or REJECTED course.
 *
 * Guard — APPROVED course:
 *  • If body contains pedagogical fields (title, objectives, syllabus, creditHours)
 *    → 409 with redirect message to POST /new-version.
 *  • Otherwise, only COURSE_APPROVED_MUTABLE_FIELDS are applied.
 */
const updateCourse = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid course ID.');

  const current = await courseRepo.findActiveByIdLean(id);
  if (!current) return sendNotFound(res, 'Course');

  const isApproved = current.approvalStatus === APPROVAL_STATUS.APPROVED;

  // Guard: pedagogical fields on APPROVED course
  if (isApproved && hasPedagogicalFields(req.body)) {
    return sendConflict(
      res,
      'Use POST /api/courses/:id/new-version to revise an approved course.',
    );
  }

  // Pick allowed fields based on approval status
  const allowedFields = isApproved
    ? COURSE_APPROVED_MUTABLE_FIELDS
    : COURSE_WRITABLE_FIELDS;

  const updates = pickFields(req.body, allowedFields);

  if (Object.keys(updates).length === 0) {
    return sendError(res, 400, 'No valid fields provided for update.');
  }

  // Validate prerequisite IDs if provided
  if (Array.isArray(updates.prerequisites)) {
    for (const p of updates.prerequisites) {
      if (!isValidObjectId(p.course)) {
        return sendError(res, 400, `Invalid prerequisite course ID: ${p.course}`);
      }
      // Prevent self-referencing prerequisite
      if (p.course.toString() === id) {
        return sendConflict(res, 'A course cannot be a prerequisite of itself.');
      }
    }
  }

  try {
    const course = await courseRepo.applyUpdate(id, updates);
    if (!course) return sendNotFound(res, 'Course');
    return sendSuccess(res, 200, 'Course updated successfully.', course);
  } catch (err) {
    if (err.code === 11000) return handleDuplicateKeyError(res, err);
    if (err.name === 'ValidationError') return sendError(res, 400, err.message);
    throw err;
  }
});

// ─── SOFT DELETE ──────────────────────────────────────────────────────────────

/**
 * DELETE /api/courses/:id
 * Soft-delete a course.
 *
 * Guard: blocked if any active Subject references this course via courseRef.
 * Physical file cleanup (coverImage, resources) is deferred to a scheduled job.
 */
const softDeleteCourse = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid course ID.');

  const current = await courseRepo.findActiveByIdLean(id);
  if (!current) return sendNotFound(res, 'Course');

  // Guard: check for active Subject references
  const affected = await subjectService().listActiveSubjectsLinkedToCourse(id);

  if (affected.length > 0) {
    // Return the list of affected campuses for transparency
    const campusNames = [
      ...new Set(affected.map((s) => s.schoolCampus?.name).filter(Boolean)),
    ];

    return sendConflict(
      res,
      `Cannot delete: this course is referenced by active subjects in campus(es): ${campusNames.join(', ')}. Unlink all subjects first.`,
    );
  }

  const deleted = await courseRepo.archiveById(id, { deletedBy: req.user.id });
  if (!deleted) return sendNotFound(res, 'Course');

  // Warn if other courses reference this one as a prerequisite (non-blocking)
  const dependentCourses = await courseRepo.listDependents(id);

  const responseData = dependentCourses.length
    ? {
        warning:          'This course was referenced as a prerequisite by other courses. Those references are now stale.',
        dependentCourses: dependentCourses.map((c) => ({
          id:             c._id,
          courseCode:     c.courseCode,
          title:          c.title,
          version:        c.version,
          approvalStatus: c.approvalStatus,
        })),
      }
    : undefined;

  return sendSuccess(res, 200, 'Course soft-deleted successfully.', responseData);
});

// ─── RESTORE ──────────────────────────────────────────────────────────────────

/**
 * PATCH /api/courses/:id/restore
 * Restore a soft-deleted course (ADMIN only).
 */
const restoreCourse = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid course ID.');

  const course = await courseRepo.restoreById(id);
  if (!course) return sendNotFound(res, 'Deleted course');

  return sendSuccess(res, 200, 'Course restored successfully.', { id: course._id });
});

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  createCourse,
  listCourses,
  getCourseById,
  getCourseByCode,
  getCourseVersions,
  updateCourse,
  softDeleteCourse,
  restoreCourse,
};