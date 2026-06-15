'use strict';

/**
 * @file course.service.js — API inter-modules du domaine course.
 *
 * Consommateurs :
 *   - staff, mentor : listApprovedCourses (catalogues lecture seule)
 *   - document : isTeacherOfAnyCourse (contrôle d'accès aux documents liés)
 *   - subject : getApprovedCourseForLinking (lien Subject → Course)
 *
 * Toute la persistance passe par course.repository (étape 0 pré-Postgres).
 */

const courseRepo = require('./course.repository');

/**
 * Catalogue paginé des cours APPROVED (dernière version, non archivés).
 * @returns {Promise<{docs: Object[], total: number}>}
 */
const listApprovedCourses = (params) => courseRepo.listApproved(params);

/**
 * Vrai si l'enseignant est assigné à au moins un des cours donnés.
 * @returns {Promise<boolean>}
 */
const isTeacherOfAnyCourse = (courseIds, teacherId) =>
  courseRepo.teacherOwnsAnyCourse(courseIds, teacherId);

/**
 * Cours éligible au lien Subject → Course (level populé).
 * @returns {Promise<Object|null>}
 */
const getApprovedCourseForLinking = (courseId) => courseRepo.findApprovedForLinking(courseId);

module.exports = {
  listApprovedCourses,
  isTeacherOfAnyCourse,
  getApprovedCourseForLinking,
};
