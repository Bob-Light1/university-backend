'use strict';

/**
 * @file department.service.js — API inter-modules du domaine department.
 *
 * Consommateurs :
 *   - campus : listDepartmentsForCampus (GET /api/campus/:campusId/departments)
 *   - teacher : getDepartmentCampusRef (validations création/édition),
 *     findDepartmentForBulk (GenericBulkController, bulkChangeDepartment)
 *
 * Toute la persistance passe par department.repository (étape 0 pré-Postgres).
 */

const departmentRepo = require('./department.repository');

/**
 * Départements d'un campus, triés par nom, headOfDepartment populé.
 * Par défaut, exclut les archivés (sauf status explicite ou includeArchived).
 * @returns {Promise<Object[]>} lean
 */
const listDepartmentsForCampus = (params) => departmentRepo.listForCampus(params);

/**
 * Référence campus d'un département ({ _id, name, schoolCampus }) — pour les
 * validations d'appartenance au campus.
 * @returns {Promise<Object|null>} lean
 */
const getDepartmentCampusRef = (id, opts = {}) => departmentRepo.getCampusRef(id, opts);

/**
 * Document Department pour GenericBulkController (requête liée à la session
 * de transaction du bulk).
 * @returns {Promise<import('mongoose').Document|null>}
 */
const findDepartmentForBulk = (id, session) => departmentRepo.findForBulk(id, session);

module.exports = {
  listDepartmentsForCampus,
  getDepartmentCampusRef,
  findDepartmentForBulk,
};
