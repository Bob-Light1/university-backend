'use strict';

/**
 * @file course.service.js — cross-module API of the course domain.
 *
 * Consumers:
 *   - staff, mentor: listApprovedCourses (read-only catalogues)
 *   - document: isTeacherOfAnyCourse (access control for linked documents)
 *   - subject: getApprovedCourseForLinking (Subject → Course link)
 *
 * All persistence goes through course.repository (step 0, pre-Postgres).
 */

const courseRepo = require('./course.repository');

/**
 * Paginated catalogue of APPROVED courses (latest version, not archived).
 * @returns {Promise<{docs: Object[], total: number}>}
 */
const listApprovedCourses = (params) => courseRepo.listApproved(params);

/**
 * True if the teacher is assigned to at least one of the given courses.
 * @returns {Promise<boolean>}
 */
const isTeacherOfAnyCourse = (courseIds, teacherId) =>
  courseRepo.teacherOwnsAnyCourse(courseIds, teacherId);

/**
 * Course eligible for the Subject → Course link (level populated).
 * @returns {Promise<Object|null>}
 */
const getApprovedCourseForLinking = (courseId) => courseRepo.findApprovedForLinking(courseId);

module.exports = {
  listApprovedCourses,
  isTeacherOfAnyCourse,
  getApprovedCourseForLinking,
};
