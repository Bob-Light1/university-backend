'use strict';

/**
 * @file department.repository.js — couche de persistance du domaine department.
 *
 * Only file in the module allowed to touch the Department model.
 * Controller and service call this repository.
 * Step 0 of the Postgres migration preparation — see POSTGRES_MIGRATION_ASSESSMENT.md §7.
 */

const Department = require('./department.model');
const { escapeRegex } = require('../../shared/utils/validation-helpers');

// Reusable populate selections (preserve the exact original fields).
const POP_CAMPUS_BASIC   = ['schoolCampus', 'campus_name'];
const POP_CAMPUS_DETAIL  = ['schoolCampus', 'campus_name location'];
const POP_HEAD_BASIC      = ['headOfDepartment', 'firstName lastName email'];
const POP_HEAD_DETAIL     = ['headOfDepartment', 'firstName lastName email matricule'];

// ── Uniqueness checks ─────────────────────────────────────────────────────────

const findByNameInCampus = (campusId, name) =>
  Department.findOne({ schoolCampus: campusId, name }).lean();

const findByCodeInCampus = (campusId, code) =>
  Department.findOne({ schoolCampus: campusId, code }).lean();

const findByNameInCampusExcept = (campusId, name, exceptId) =>
  Department.findOne({ schoolCampus: campusId, name, _id: { $ne: exceptId } }).lean();

const findByCodeInCampusExcept = (campusId, code, exceptId) =>
  Department.findOne({ schoolCampus: campusId, code, _id: { $ne: exceptId } }).lean();

// ── Lectures ─────────────────────────────────────────────────────────────────

/** Minimal reference (campus/uniqueness preconditions). @returns {Promise<Object|null>} */
const findByIdLean = (id) => Department.findById(id).lean();

/** Populated department (standard response: campus_name + head). */
const findByIdForResponse = (id) =>
  Department.findById(id).populate(...POP_CAMPUS_BASIC).populate(...POP_HEAD_BASIC).lean();

/** Detailed populated department (single-item view: + location, matricule). */
const findByIdDetailed = (id) =>
  Department.findById(id).populate(...POP_CAMPUS_DETAIL).populate(...POP_HEAD_DETAIL).lean();

/**
 * Paginated list for the admin controller (campus + head populated).
 * @param {{ baseFilter: Object, includeArchived?: boolean, status?: string, search?: string, skip: number, limit: number }} p
 * @returns {Promise<{data: Object[], total: number}>}
 */
const paginate = async ({ baseFilter, includeArchived, status, search, skip, limit }) => {
  const filter = { ...baseFilter };
  if (includeArchived !== true) filter.status = { $ne: 'archived' };
  if (status) filter.status = status;
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    filter.$or = [{ name: rx }, { code: rx }, { description: rx }];
  }

  const [data, total] = await Promise.all([
    Department.find(filter)
      .populate(...POP_CAMPUS_BASIC).populate(...POP_HEAD_BASIC)
      .sort({ name: 1 }).skip(skip).limit(limit).lean(),
    Department.countDocuments(filter),
  ]);
  return { data, total };
};

/**
 * Departments for a campus (inter-module API — head populated, without the campus).
 * @returns {Promise<Object[]>}
 */
const listForCampus = ({ campusId, status, includeArchived = false, search }) => {
  const filter = { schoolCampus: campusId };
  if (status) filter.status = status;
  else if (!includeArchived) filter.status = { $ne: 'archived' };
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    filter.$or = [{ name: rx }, { code: rx }, { description: rx }];
  }
  return Department.find(filter).populate(...POP_HEAD_BASIC).sort({ name: 1 }).lean();
};

/** Campus reference for a department ({ _id, name, schoolCampus }). */
const getCampusRef = (id, { session = null } = {}) =>
  Department.findById(id).select('schoolCampus name').session(session).lean();

/** Department document bound to a transaction session (GenericBulkController). */
const findForBulk = (id, session) => Department.findById(id).session(session);

// ── Writes ───────────────────────────────────────────────────────────────────

/** Creates a department. @returns {Promise<Document>} */
const create = (data) => Department.create(data);

/**
 * Updates a department and returns the populated version (basic).
 * @returns {Promise<Object|null>}
 */
const updateById = (id, updates) =>
  Department.findByIdAndUpdate(id, updates, { new: true, runValidators: true })
    .populate(...POP_CAMPUS_BASIC).populate(...POP_HEAD_BASIC).lean();

/**
 * Changes the status (load→save, preserves hooks/validations).
 * @returns {Promise<Document|null>}
 */
const setStatus = async (id, status) => {
  const dept = await Department.findById(id);
  if (!dept) return null;
  dept.status = status;
  await dept.save();
  return dept;
};

module.exports = {
  findByNameInCampus,
  findByCodeInCampus,
  findByNameInCampusExcept,
  findByCodeInCampusExcept,
  findByIdLean,
  findByIdForResponse,
  findByIdDetailed,
  paginate,
  listForCampus,
  getCampusRef,
  findForBulk,
  create,
  updateById,
  setStatus,
};
