'use strict';

/**
 * @file mentor.repository.js — couche de persistance du domaine mentor.
 *
 * SEUL fichier du module autorisé à interroger le model Mentor directement
 * (controller + readonly + service). Étape 0 de la préparation Postgres — voir
 * POSTGRES_MIGRATION_ASSESSMENT.md §7.
 *
 * NB : le model a un hook pre('save') qui hashe le mot de passe → la création
 * passe par Mentor.create (déclenche le hook). Les profils self-service passent
 * le model au service partagé profile.service (hors périmètre, comme admin).
 * Le filtre campus (isolation multi-tenant) est construit par le controller et
 * passé en paramètre.
 */

const Mentor = require('./mentor.model');
const { escapeRegex } = require('../../shared/utils/validation-helpers');

const RESPONSE_SELECT = '-password -__v';

// ── Login ─────────────────────────────────────────────────────────────────────

/** Search by email/username WITH the password hash (login). */
const findByCredential = (query) =>
  Mentor.findOne(query).select('+password').lean({ virtuals: true });

/** Updates lastLogin (fire-and-forget). */
const touchLastLogin = (id) =>
  Mentor.findByIdAndUpdate(id, { lastLogin: new Date() }).exec();

// ── CRUD (controller) ─────────────────────────────────────────────────────────

/** Creates a mentor (Mentor.create → triggers the pre('save') hash). @returns {Promise<Document>} */
const create = (data) => Mentor.create(data);

/**
 * Liste paginée pour le controller CM (campus_name peuplé).
 * @returns {Promise<{data: Object[], total: number}>}
 */
const paginate = async ({ campusFilter, status, includeArchived, search, skip, limit }) => {
  const filter = { ...campusFilter };
  if (status) filter.status = status;
  else if (includeArchived !== true) filter.status = { $ne: 'archived' };
  if (search) {
    const rx = new RegExp(escapeRegex(search.trim()), 'i');
    filter.$or = [{ firstName: rx }, { lastName: rx }, { email: rx }, { username: rx }];
  }

  const [data, total] = await Promise.all([
    Mentor.find(filter)
      .select(RESPONSE_SELECT)
      .populate('schoolCampus', 'campus_name')
      .sort({ createdAt: -1 })
      .skip(skip).limit(limit).lean({ virtuals: true }),
    Mentor.countDocuments(filter),
  ]);
  return { data, total };
};

/** Read a mentor within the scope (campus_name populated). */
const findOneScoped = (scopeFilter) =>
  Mentor.findOne(scopeFilter)
    .select(RESPONSE_SELECT)
    .populate('schoolCampus', 'campus_name')
    .lean({ virtuals: true });

/** Raw read within the scope (preconditions: _id, schoolCampus). */
const findOneScopedLean = (scopeFilter) => Mentor.findOne(scopeFilter).lean();

/** Authenticated mentor's data: students/classes/campus (readonly). */
const findAssignmentsFor = (id, campusId) =>
  Mentor.findOne({ _id: id, schoolCampus: campusId })
    .select('students classes schoolCampus')
    .lean();

/** Scoped update (PUT). @returns {Promise<Object|null>} */
const updateScoped = (scopeFilter, body) =>
  Mentor.findOneAndUpdate(scopeFilter, { $set: body }, { new: true, runValidators: true })
    .select(RESPONSE_SELECT).lean({ virtuals: true });

/** Changement de statut scoped (status/archive/restore). @returns {Promise<Object|null>} */
const setStatusScoped = (scopeFilter, status) =>
  Mentor.findOneAndUpdate(scopeFilter, { $set: { status } }, { new: true })
    .select(RESPONSE_SELECT).lean({ virtuals: true });

/** Updates the password (already hashed — bypasses pre('save')). */
const updatePassword = (id, hashedPassword) =>
  Mentor.findByIdAndUpdate(id, { password: hashedPassword });

/** Permanent deletion. */
const deleteById = (id) => Mentor.findByIdAndDelete(id);

/** Applies the student assignment (add/remove/replace), students populated. */
const applyStudentAssignment = (id, updateOp) =>
  Mentor.findByIdAndUpdate(id, updateOp, { new: true })
    .select(RESPONSE_SELECT)
    .populate('students', 'firstName lastName email matricule studentClass status profileImage')
    .lean({ virtuals: true });

// ── API inter-modules (ancien mentor.service) ─────────────────────────────────

/** Compteur de mentors d'un campus (status = valeur ou objet $ne). */
const countByCampus = (campusId, status) =>
  Mentor.countDocuments({ schoolCampus: campusId, status });

/** Total assigned students (campus dashboard). */
const aggregateAssignedStudents = (campusOid) =>
  Mentor.aggregate([
    { $match: { schoolCampus: campusOid, status: { $ne: 'archived' } } },
    { $group: { _id: null, total: { $sum: { $size: '$students' } } } },
  ]);

/**
 * Liste paginée pour le dashboard campus (assignedStudents peuplés).
 * @returns {Promise<{mentors: Object[], total: number}>}
 */
const listForCampusService = async ({ campusId, status, search, skip, limit }) => {
  const filter = { schoolCampus: campusId };
  if (status) filter.status = status;
  else filter.status = { $ne: 'archived' };
  if (search) {
    const fields = ['firstName', 'lastName', 'email', 'phone', 'specialization', 'matricule'];
    filter.$or = fields.map((f) => ({ [f]: { $regex: escapeRegex(search), $options: 'i' } }));
  }

  const [mentors, total] = await Promise.all([
    Mentor.find(filter)
      .populate('assignedStudents', 'firstName lastName matricule')
      .select('-password')
      .sort({ createdAt: -1 })
      .skip(skip).limit(limit).lean(),
    Mentor.countDocuments(filter),
  ]);
  return { mentors, total };
};

module.exports = {
  findByCredential,
  touchLastLogin,
  create,
  paginate,
  findOneScoped,
  findOneScopedLean,
  findAssignmentsFor,
  updateScoped,
  setStatusScoped,
  updatePassword,
  deleteById,
  applyStudentAssignment,
  countByCampus,
  aggregateAssignedStudents,
  listForCampusService,
};
