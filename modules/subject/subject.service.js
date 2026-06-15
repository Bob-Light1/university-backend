'use strict';

/**
 * @file subject.service.js — API inter-modules du domaine subject.
 *
 * Exposé :
 *   - countSubjectsOnCampus        : garde campus en masse (gaet).
 *   - listCampusSubjects           : listing dashboard campus (campus.controller).
 *   - getLinkedCourseRefIds        : ids de cours liés à un subject actif (course.crud, filtre isLinked).
 *   - listActiveSubjectsLinkedToCourse : garde de suppression d'un cours (course.crud).
 *   - getSubjectCampusRef          : validation cross-campus (exam.session).
 *   - resolveSubjectForSchedule    : forme dénormalisée subject{} des emplois
 *     du temps (student.schedule.helpers).
 *
 * Toute la persistance passe par subject.repository (étape 0 pré-Postgres).
 */

const subjectRepo = require('./subject.repository');

const countSubjectsOnCampus = (subjectIds, campusId) =>
  subjectRepo.countOnCampus(subjectIds, campusId);

const listCampusSubjects = (params) => subjectRepo.listForCampus(params);

const getLinkedCourseRefIds = () => subjectRepo.distinctLinkedCourseRefs();

const listActiveSubjectsLinkedToCourse = (courseId) =>
  subjectRepo.listActiveLinkedToCourse(courseId);

const getSubjectCampusRef = (subjectId) => subjectRepo.getCampusRef(subjectId);

const resolveSubjectForSchedule = (subjectId, campusId) =>
  subjectRepo.resolveForSchedule(subjectId, campusId);

module.exports = {
  countSubjectsOnCampus,
  listCampusSubjects,
  getLinkedCourseRefIds,
  listActiveSubjectsLinkedToCourse,
  getSubjectCampusRef,
  resolveSubjectForSchedule,
};
