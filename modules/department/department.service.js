'use strict';

/**
 * @file department.service.js — API inter-modules du domaine department.
 *
 * Consommateurs :
 *   - campus : listDepartmentsForCampus (GET /api/campus/:campusId/departments)
 *   - teacher : getDepartmentCampusRef (creation/update validations),
 *     findDepartmentForBulk (GenericBulkController, bulkChangeDepartment)
 *
 * All persistence goes through department.repository (step 0 pre-Postgres).
 */

const departmentRepo = require('./department.repository');

/**
 * Departments for a campus, sorted by name, headOfDepartment populated.
 * Excludes archived by default (unless an explicit status or includeArchived is provided).
 * @returns {Promise<Object[]>} lean
 */
const listDepartmentsForCampus = (params) => departmentRepo.listForCampus(params);

/**
 * Campus reference for a department ({ _id, name, schoolCampus }) — used for
 * campus membership validations.
 * @returns {Promise<Object|null>} lean
 */
const getDepartmentCampusRef = (id, opts = {}) => departmentRepo.getCampusRef(id, opts);

/**
 * Department document for GenericBulkController (query bound to the bulk
 * transaction session).
 * @returns {Promise<import('mongoose').Document|null>}
 */
const findDepartmentForBulk = (id, session) => departmentRepo.findForBulk(id, session);

module.exports = {
  listDepartmentsForCampus,
  getDepartmentCampusRef,
  findDepartmentForBulk,
};
