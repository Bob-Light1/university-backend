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
// Lazy require: the teacher ↔ course relationship lives in the subject domain
// (courses are global; the link only exists through campus-scoped Subjects).
// Loaded lazily to avoid the course ↔ subject module cycle.
const subjectService = () => require('../subject').service;

/**
 * Paginated catalogue of APPROVED courses (latest version, not archived).
 * @returns {Promise<{docs: Object[], total: number}>}
 */
const listApprovedCourses = (params) => courseRepo.listApproved(params);

/**
 * True if the teacher is assigned to at least one of the given courses.
 * A teacher is "of a course" when they teach an active Subject that links the
 * course via courseRef — delegated to the subject domain.
 * @returns {Promise<boolean>}
 */
const isTeacherOfAnyCourse = (courseIds, teacherId) =>
  subjectService().isTeacherLinkedToAnyCourse(courseIds, teacherId);

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
