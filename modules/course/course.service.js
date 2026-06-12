'use strict';

/**
 * @file course.service.js — API inter-modules du domaine course.
 *
 * Consommateurs :
 *   - staff, mentor : listApprovedCourses (catalogues lecture seule)
 *   - document : isTeacherOfAnyCourse (contrôle d'accès aux documents liés)
 *   - subject : getApprovedCourseForLinking (lien Subject → Course)
 */

const { Course, APPROVAL_STATUS } = require('./course.model');

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Catalogue paginé des cours APPROVED (dernière version, non archivés),
 * triés par titre, avec subject et createdBy populés.
 * @param {Object} p
 * @param {string} [p.search] — sur title/courseCode/description
 * @param {number} [p.page=1], [p.limit=20]
 * @returns {Promise<{docs: Object[], total: number}>}
 */
const listApprovedCourses = async ({ search, page = 1, limit = 20 } = {}) => {
  const filter = {
    approvalStatus:  APPROVAL_STATUS.APPROVED,
    isLatestVersion: true,
    status:          { $ne: 'archived' },
  };
  if (search) {
    const rx = new RegExp(escapeRegex(search.trim()), 'i');
    filter.$or = [{ title: rx }, { courseCode: rx }, { description: rx }];
  }

  const skip = (Number(page) - 1) * Number(limit);
  const [docs, total] = await Promise.all([
    Course.find(filter)
      .select('-__v')
      .populate('subject',   'subject_name')
      .populate('createdBy', 'firstName lastName')
      .sort({ title: 1 })
      .skip(skip).limit(Number(limit)).lean(),
    Course.countDocuments(filter),
  ]);
  return { docs, total };
};

/**
 * Vrai si l'enseignant est assigné à au moins un des cours donnés.
 * @param {Array<ObjectId|string>} courseIds
 * @param {ObjectId|string} teacherId
 * @returns {Promise<boolean>}
 */
const isTeacherOfAnyCourse = async (courseIds, teacherId) => {
  const owned = await Course.findOne({
    _id:     { $in: courseIds },
    teacher: teacherId,
  }).select('_id').lean();
  return owned != null;
};

/**
 * Cours éligible au lien Subject → Course : APPROVED, dernière version,
 * non archivé — level populé pour la validation croisée avec la classe.
 * @param {ObjectId|string} courseId
 * @returns {Promise<Object|null>} lean
 */
const getApprovedCourseForLinking = (courseId) =>
  Course.findOne({
    _id:             courseId,
    status:          { $ne: 'archived' },
    approvalStatus:  APPROVAL_STATUS.APPROVED,
    isLatestVersion: true,
  }).populate('level', 'name').lean();

module.exports = {
  listApprovedCourses,
  isTeacherOfAnyCourse,
  getApprovedCourseForLinking,
};
