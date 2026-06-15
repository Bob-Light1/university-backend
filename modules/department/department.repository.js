'use strict';

/**
 * @file department.repository.js — couche de persistance du domaine department.
 *
 * SEUL fichier du module autorisé à toucher le model Department.
 * Controller et service appellent ce repository.
 * Étape 0 de la préparation Postgres — voir POSTGRES_MIGRATION_ASSESSMENT.md §7.
 */

const Department = require('./department.model');
const { escapeRegex } = require('../../shared/utils/validation-helpers');

// Sélections de populate réutilisées (préservent les champs exacts d'origine).
const POP_CAMPUS_BASIC   = ['schoolCampus', 'campus_name'];
const POP_CAMPUS_DETAIL  = ['schoolCampus', 'campus_name location'];
const POP_HEAD_BASIC      = ['headOfDepartment', 'firstName lastName email'];
const POP_HEAD_DETAIL     = ['headOfDepartment', 'firstName lastName email matricule'];

// ── Contrôles d'unicité ───────────────────────────────────────────────────────

const findByNameInCampus = (campusId, name) =>
  Department.findOne({ schoolCampus: campusId, name }).lean();

const findByCodeInCampus = (campusId, code) =>
  Department.findOne({ schoolCampus: campusId, code }).lean();

const findByNameInCampusExcept = (campusId, name, exceptId) =>
  Department.findOne({ schoolCampus: campusId, name, _id: { $ne: exceptId } }).lean();

const findByCodeInCampusExcept = (campusId, code, exceptId) =>
  Department.findOne({ schoolCampus: campusId, code, _id: { $ne: exceptId } }).lean();

// ── Lectures ─────────────────────────────────────────────────────────────────

/** Référence minimale (préconditions campus/uniqueness). @returns {Promise<Object|null>} */
const findByIdLean = (id) => Department.findById(id).lean();

/** Département peuplé (réponse standard : campus_name + chef). */
const findByIdForResponse = (id) =>
  Department.findById(id).populate(...POP_CAMPUS_BASIC).populate(...POP_HEAD_BASIC).lean();

/** Département peuplé détaillé (vue unitaire : + location, matricule). */
const findByIdDetailed = (id) =>
  Department.findById(id).populate(...POP_CAMPUS_DETAIL).populate(...POP_HEAD_DETAIL).lean();

/**
 * Liste paginée pour le controller admin (campus + chef peuplés).
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
 * Départements d'un campus (API inter-modules — chef peuplé, sans le campus).
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

/** Référence campus d'un département ({ _id, name, schoolCampus }). */
const getCampusRef = (id, { session = null } = {}) =>
  Department.findById(id).select('schoolCampus name').session(session).lean();

/** Document Department lié à une session de transaction (GenericBulkController). */
const findForBulk = (id, session) => Department.findById(id).session(session);

// ── Écritures ────────────────────────────────────────────────────────────────

/** Crée un département. @returns {Promise<Document>} */
const create = (data) => Department.create(data);

/**
 * Met à jour un département et renvoie la version peuplée (basic).
 * @returns {Promise<Object|null>}
 */
const updateById = (id, updates) =>
  Department.findByIdAndUpdate(id, updates, { new: true, runValidators: true })
    .populate(...POP_CAMPUS_BASIC).populate(...POP_HEAD_BASIC).lean();

/**
 * Change le statut (load→save, préserve hooks/validations).
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
