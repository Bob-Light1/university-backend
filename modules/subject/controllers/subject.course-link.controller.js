'use strict';

/**
 * @file subject.course-link.controller.js
 * @description Lien Subject → Course (courseRef).
 *
 *  Endpoints :
 *  ─────────────────────────────────────────────────────────────────
 *  PATCH  /api/subject/:id/link-course   → linkSubjectCourse
 *  DELETE /api/subject/:id/link-course   → unlinkSubjectCourse
 *
 *  Moved from course.resources.controller (task 20b): these handlers
 *  mutate the Subject (courseRef) — subject domain. Course-side validation
 *  (APPROVED + latest version) goes through the course module facade.
 *
 *  Security notes:
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

const subjectRepo   = require('../subject.repository');
const { getClassForCourseLink } = require('../../class').service; // facade module class (§3)
const courseService = require('../../course').service; // facade module course (§3)

const {
  asyncHandler,
  sendSuccess,
  sendError,
  sendNotFound,
  sendConflict,
  sendForbidden,
} = require('../../../shared/utils/response-helpers');

const { isValidObjectId } = require('../../../shared/utils/validation-helpers');

// ─── LINK SUBJECT → COURSE ────────────────────────────────────────────────────

/**
 * PATCH /api/subject/:id/link-course
 * Roles: ADMIN, DIRECTOR, CAMPUS_MANAGER.
 *
 * Validations:
 *  1. The referenced Course must be APPROVED and isLatestVersion: true.
 *  2. Campus isolation: Subject.schoolCampus must match the user's campus
 *     for non-global roles.
 *  3. Level compatibility (optional but enforced when classId is provided):
 *     Class.level must equal Course.level, AND Class.schoolCampus must equal
 *     Subject.schoolCampus.
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

  const subject = await subjectRepo.findByIdLean(id);
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

  // Validate the Course: must be APPROVED and latest version (course facade)
  const course = await courseService.getApprovedCourseForLinking(courseId);

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
  if (classId) {
    const targetClass = await getClassForCourseLink(classId, subject.schoolCampus);

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

  await subjectRepo.setCourseRef(id, courseId);

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

  const subject = await subjectRepo.findByIdLean(id);
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

  await subjectRepo.setCourseRef(id, null);

  return sendSuccess(res, 200, 'Course unlinked from subject successfully.');
});

module.exports = {
  linkSubjectCourse,
  unlinkSubjectCourse,
};
