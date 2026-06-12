'use strict';

/**
 * @file department.service.js — API inter-modules du domaine department.
 *
 * Consommateurs :
 *   - campus : listDepartmentsForCampus (GET /api/campus/:campusId/departments)
 *   - teacher : getDepartmentCampusRef (validations création/édition),
 *     findDepartmentForBulk (GenericBulkController, bulkChangeDepartment)
 */

const Department = require('./department.model');

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Départements d'un campus, triés par nom, headOfDepartment populé.
 * Par défaut, exclut les archivés (sauf status explicite ou includeArchived).
 * @param {Object} p
 * @param {ObjectId|string} p.campusId
 * @param {string} [p.status]
 * @param {boolean} [p.includeArchived=false]
 * @param {string} [p.search] — sur name/code/description
 * @returns {Promise<Object[]>} lean
 */
const listDepartmentsForCampus = ({ campusId, status, includeArchived = false, search }) => {
  const filter = { schoolCampus: campusId };
  if (status) filter.status = status;
  else if (!includeArchived) filter.status = { $ne: 'archived' };

  if (search) {
    filter.$or = [
      { name:        { $regex: escapeRegex(search), $options: 'i' } },
      { code:        { $regex: escapeRegex(search), $options: 'i' } },
      { description: { $regex: escapeRegex(search), $options: 'i' } },
    ];
  }

  return Department.find(filter)
    .populate('headOfDepartment', 'firstName lastName email')
    .sort({ name: 1 })
    .lean();
};

/**
 * Référence campus d'un département ({ _id, name, schoolCampus }) — pour les
 * validations d'appartenance au campus.
 * @param {ObjectId|string} id
 * @param {Object} [opts]
 * @param {import('mongoose').ClientSession} [opts.session]
 * @returns {Promise<Object|null>} lean
 */
const getDepartmentCampusRef = (id, { session = null } = {}) =>
  Department.findById(id).select('schoolCampus name').session(session).lean();

/**
 * Document Department pour GenericBulkController (requête liée à la session
 * de transaction du bulk).
 * @param {ObjectId|string} id
 * @param {import('mongoose').ClientSession} session
 * @returns {Promise<import('mongoose').Document|null>}
 */
const findDepartmentForBulk = (id, session) =>
  Department.findById(id).session(session);

module.exports = {
  listDepartmentsForCampus,
  getDepartmentCampusRef,
  findDepartmentForBulk,
};
