'use strict';

/**
 * @file class.service.js — API inter-modules du domaine class.
 *
 * Exposé (consommé par gaet, campus, student.schedule.helpers, subject.course-link,
 * document.template, exam.session, result.crud, student.config, teacher.config,
 * student.controller, academic-print). Toute la persistance passe par
 * class.repository (étape 0 pré-Postgres).
 */

const classRepo = require('./class.repository');

const countClassesOnCampus = (classIds, campusId) => classRepo.countOnCampus(classIds, campusId);
const countClasses = (params) => classRepo.countByCampus(params);
const listClassesForCampus = (params) => classRepo.listForCampusDashboard(params);
const resolveClassesForSchedule = (classIds, campusId) => classRepo.resolveForSchedule(classIds, campusId);
const getClassForCourseLink = (classId, campusId) => classRepo.findForCourseLink(classId, campusId);
const getClassForDocumentList = (classId, campusId) => classRepo.findForDocumentList(classId, campusId);
const getClassCampusRef = (classId) => classRepo.getCampusRef(classId);
const getClassCampusRefForValidation = (classId, opts) => classRepo.getCampusRefForValidation(classId, opts);
const getClassesCampusRefs = (classIds, opts) => classRepo.getCampusRefsByIds(classIds, opts);
const classExistsInCampus = (classId, campusId) => classRepo.existsInCampus(classId, campusId);
const findClassManagedBy = (teacherId, campusId) => classRepo.findManagedBy(teacherId, campusId);
const getClassName = (classId) => classRepo.getName(classId);
const getClassNameInCampus = (classId, campusId) => classRepo.getNameInCampus(classId, campusId);
const findClassForBulk = (id, session) => classRepo.findForBulk(id, session);
const addTeacherToClasses = (params) => classRepo.addTeacherToClasses(params);
const removeTeacherFromClasses = (params) => classRepo.removeTeacherFromClasses(params);
const setClassManager = (params) => classRepo.setClassManager(params);
const clearClassManager = (params) => classRepo.clearClassManager(params);

module.exports = {
  countClassesOnCampus,
  countClasses,
  listClassesForCampus,
  resolveClassesForSchedule,
  getClassForCourseLink,
  getClassForDocumentList,
  getClassCampusRef,
  getClassCampusRefForValidation,
  getClassesCampusRefs,
  getClassName,
  getClassNameInCampus,
  classExistsInCampus,
  findClassManagedBy,
  findClassForBulk,
  addTeacherToClasses,
  removeTeacherFromClasses,
  setClassManager,
  clearClassManager,
};
