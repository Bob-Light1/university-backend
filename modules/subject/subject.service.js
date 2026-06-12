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
 */

const Subject = require('./subject.model');

/**
 * Compte les subjects appartenant à un campus parmi une liste d'ids.
 * @param {string[]} subjectIds
 * @param {string} campusId
 * @returns {Promise<number>}
 */
const countSubjectsOnCampus = (subjectIds, campusId) =>
  Subject.countDocuments({ _id: { $in: subjectIds }, schoolCampus: campusId });

/**
 * Subjects d'un campus (department + teachers peuplés, triés par nom).
 * @param {{campusId: string, status?: string}} params
 * @returns {Promise<Array>}
 */
const listCampusSubjects = async ({ campusId, status }) => {
  const filter = { schoolCampus: campusId };
  if (status) filter.status = status;

  return Subject.find(filter)
    .populate('department', 'name')
    .populate('teachers',   'firstName lastName')
    .sort({ name: 1 })
    .lean();
};

/**
 * Ids des cours référencés par au moins un subject actif (filtre isLinked).
 * @returns {Promise<Array>}
 */
const getLinkedCourseRefIds = () =>
  Subject.distinct('courseRef', { status: 'active', courseRef: { $ne: null } });

/**
 * Subjects actifs référençant un cours (garde de suppression) —
 * schoolCampus peuplé (name) pour le message d'erreur.
 * @param {string} courseId
 * @returns {Promise<Array>}
 */
const listActiveSubjectsLinkedToCourse = (courseId) =>
  Subject.find({ courseRef: courseId, status: 'active' })
    .select('schoolCampus subject_name')
    .populate('schoolCampus', 'name')
    .lean();

/**
 * Référence campus d'un subject (validation cross-campus).
 * @param {string} subjectId
 * @returns {Promise<{_id, schoolCampus}|null>}
 */
const getSubjectCampusRef = (subjectId) =>
  Subject.findById(subjectId).select('schoolCampus').lean();

/**
 * Resolves a subjectId string into the denormalised `subject{}` shape
 * expected by StudentSchedule / TeacherSchedule models.
 *
 * Campus isolation: subject must belong to campusId.
 *
 * @param {string} subjectId
 * @param {string} campusId
 * @returns {Promise<{
 *   subjectId:    ObjectId,
 *   subject_name: string,
 *   subject_code: string,
 *   coefficient:  number|null,
 *   department:   ObjectId|null
 * } | null>}  null if not found or campus mismatch
 */
const resolveSubjectForSchedule = async (subjectId, campusId) => {
  if (!subjectId) return null;

  const doc = await Subject.findOne({
    _id:          subjectId,
    schoolCampus: campusId,   // campus-isolation guard
    status:       { $ne: 'archived' },
  })
    .select('_id subject_name subject_code coefficient department')
    .lean();

  if (!doc) return null;

  return {
    subjectId:    doc._id,
    subject_name: doc.subject_name,
    subject_code: doc.subject_code,
    coefficient:  doc.coefficient  ?? null,
    department:   doc.department   ?? null,
  };
};

module.exports = {
  countSubjectsOnCampus,
  listCampusSubjects,
  getLinkedCourseRefIds,
  listActiveSubjectsLinkedToCourse,
  getSubjectCampusRef,
  resolveSubjectForSchedule,
};
