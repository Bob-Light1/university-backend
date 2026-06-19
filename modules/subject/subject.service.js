'use strict';

/**
 * @file subject.service.js — inter-module API of the subject domain.
 *
 * Exposes:
 *   - countSubjectsOnCampus        : bulk campus guard (gaet).
 *   - listCampusSubjects           : campus dashboard listing (campus.controller).
 *   - getLinkedCourseRefIds        : course ids linked to an active subject (course.crud, isLinked filter).
 *   - listActiveSubjectsLinkedToCourse : course deletion guard (course.crud).
 *   - isTeacherLinkedToAnyCourse    : teacher ↔ course access control (document, via course facade).
 *   - getSubjectCampusRef          : cross-campus validation (exam.session).
 *   - resolveSubjectForSchedule    : denormalized subject{} shape for
 *     schedules (student.schedule.helpers).
 *
 * All persistence goes through subject.repository (step 0 pre-Postgres).
 */

const subjectRepo = require('./subject.repository');

const countSubjectsOnCampus = (subjectIds, campusId) =>
  subjectRepo.countOnCampus(subjectIds, campusId);

const listCampusSubjects = (params) => subjectRepo.listForCampus(params);

const getLinkedCourseRefIds = () => subjectRepo.distinctLinkedCourseRefs();

const listActiveSubjectsLinkedToCourse = (courseId) =>
  subjectRepo.listActiveLinkedToCourse(courseId);

const isTeacherLinkedToAnyCourse = (courseIds, teacherId) =>
  subjectRepo.existsTeacherLinkedToCourse(courseIds, teacherId);

const getSubjectCampusRef = (subjectId) => subjectRepo.getCampusRef(subjectId);

const getSubjectsCampusRefs = (subjectIds, opts) => subjectRepo.getCampusRefsByIds(subjectIds, opts);

const resolveSubjectForSchedule = (subjectId, campusId) =>
  subjectRepo.resolveForSchedule(subjectId, campusId);

module.exports = {
  countSubjectsOnCampus,
  listCampusSubjects,
  getLinkedCourseRefIds,
  listActiveSubjectsLinkedToCourse,
  isTeacherLinkedToAnyCourse,
  getSubjectCampusRef,
  getSubjectsCampusRefs,
  resolveSubjectForSchedule,
};
