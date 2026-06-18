'use strict';

/**
 * @file subject.repository.js — couche de persistance du domaine subject.
 *
 * SEUL fichier du module autorisé à toucher le model Subject (subject.controller,
 * subject.course-link.controller, subject.service). Étape 0 de la préparation
 * Postgres — voir POSTGRES_MIGRATION_ASSESSMENT.md §7.
 *
 * Lectures → objets simples (`.lean()`) ; écritures → load→mutate→save (préserve
 * le hook pre('save') et les setters du schéma).
 */

const Subject = require('./subject.model');
const { escapeRegex } = require('../../shared/utils/validation-helpers');

// ── Contrôles d'unicité ───────────────────────────────────────────────────────

const findDuplicateCode = (campusId, code) =>
  Subject.findOne({ schoolCampus: campusId, subject_code: code }).lean();

const findDuplicateCodeExcept = (campusId, code, exceptId) =>
  Subject.findOne({ _id: { $ne: exceptId }, schoolCampus: campusId, subject_code: code }).lean();

// ── Lectures (controller) ─────────────────────────────────────────────────────

/** Référence brute (préconditions : schoolCampus, status, courseRef…). */
const findByIdLean = (id) => Subject.findById(id).lean();

/** Réponse standard : campus_name peuplé. */
const findByIdForResponse = (id) =>
  Subject.findById(id).populate('schoolCampus', 'campus_name').lean();

/** Vue unitaire : campus_name + location peuplés. */
const findByIdDetailed = (id) =>
  Subject.findById(id).populate('schoolCampus', 'campus_name location').lean();

/** Réfs campus d'un lot de subjects (validation batch subjects∈campus — teacher.config). */
const getCampusRefsByIds = (subjectIds, { session } = {}) =>
  Subject.find({ _id: { $in: subjectIds } }).select('schoolCampus').session(session).lean();

/**
 * Liste paginée (campus + statut/catégorie/recherche), campus_name peuplé,
 * tri par subject_name.
 * @returns {Promise<{data: Object[], total: number}>}
 */
const paginate = async ({ baseFilter, includeArchived, status, category, search, skip, limit }) => {
  const filter = { ...baseFilter };
  if (includeArchived !== true) {
    filter.status = { $ne: 'archived' };
  } else if (status && ['active', 'archived'].includes(status)) {
    filter.status = status;
  }
  if (category) filter.category = category;
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    filter.$or = [{ subject_name: rx }, { subject_code: rx }];
  }

  const [data, total] = await Promise.all([
    Subject.find(filter).sort({ subject_name: 1 }).skip(skip).limit(limit)
      .populate('schoolCampus', 'campus_name').lean(),
    Subject.countDocuments(filter),
  ]);
  return { data, total };
};

// ── Écritures (load→save) ─────────────────────────────────────────────────────

/** Crée un subject. @returns {Promise<Document>} */
const create = (data) => Subject.create(data);

/** Applique les champs fournis (load→assign→save). @returns {Promise<Document|null>} */
const updateById = async (id, fields) => {
  const subject = await Subject.findById(id);
  if (!subject) return null;
  Object.assign(subject, fields);
  await subject.save();
  return subject;
};

/** Change le statut (active/archived). @returns {Promise<Document|null>} */
const setStatus = async (id, status) => {
  const subject = await Subject.findById(id);
  if (!subject) return null;
  subject.status = status;
  await subject.save();
  return subject;
};

/** Définit (ou retire avec null) le courseRef. @returns {Promise<Document|null>} */
const setCourseRef = async (id, courseRef) => {
  const subject = await Subject.findById(id);
  if (!subject) return null;
  subject.courseRef = courseRef;
  await subject.save();
  return subject;
};

// ── API inter-modules (ancien subject.service) ────────────────────────────────

/** Compte les subjects d'un campus parmi une liste d'ids. */
const countOnCampus = (subjectIds, campusId) =>
  Subject.countDocuments({ _id: { $in: subjectIds }, schoolCampus: campusId });

/** Subjects d'un campus (department + teachers peuplés). */
const listForCampus = ({ campusId, status }) => {
  const filter = { schoolCampus: campusId };
  if (status) filter.status = status;
  return Subject.find(filter)
    .populate('department', 'name')
    .populate('teachers',   'firstName lastName')
    .sort({ name: 1 })
    .lean();
};

/** Ids de cours référencés par au moins un subject actif. */
const distinctLinkedCourseRefs = () =>
  Subject.distinct('courseRef', { status: 'active', courseRef: { $ne: null } });

/** Subjects actifs référençant un cours (schoolCampus.name peuplé). */
const listActiveLinkedToCourse = (courseId) =>
  Subject.find({ courseRef: courseId, status: 'active' })
    .select('schoolCampus subject_name')
    .populate('schoolCampus', 'name')
    .lean();

/** Référence campus d'un subject. */
const getCampusRef = (subjectId) =>
  Subject.findById(subjectId).select('schoolCampus').lean();

/**
 * Forme dénormalisée subject{} pour les emplois du temps (campus-isolée).
 * @returns {Promise<Object|null>}
 */
const resolveForSchedule = async (subjectId, campusId) => {
  if (!subjectId) return null;
  const doc = await Subject.findOne({
    _id:          subjectId,
    schoolCampus: campusId,
    status:       { $ne: 'archived' },
  }).select('_id subject_name subject_code coefficient department').lean();

  if (!doc) return null;
  return {
    subjectId:    doc._id,
    subject_name: doc.subject_name,
    subject_code: doc.subject_code,
    coefficient:  doc.coefficient ?? null,
    department:   doc.department  ?? null,
  };
};

module.exports = {
  findDuplicateCode,
  findDuplicateCodeExcept,
  findByIdLean,
  findByIdForResponse,
  findByIdDetailed,
  paginate,
  create,
  updateById,
  setStatus,
  setCourseRef,
  countOnCampus,
  listForCampus,
  distinctLinkedCourseRefs,
  listActiveLinkedToCourse,
  getCampusRef,
  getCampusRefsByIds,
  resolveForSchedule,
};
