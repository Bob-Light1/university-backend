'use strict';

/**
 * @file staff.repository.js — couche de persistance du model Staff.
 *
 * SEUL fichier autorisé à interroger Staff (controller + service ; staffRole
 * passe par isRoleInUse). Étape 0 de la préparation Postgres — voir
 * POSTGRES_MIGRATION_ASSESSMENT.md §7.
 *
 * Le model a un hook pre('save') qui hashe le mot de passe → la création passe
 * par Staff.create. Les profils self-service passent le model au service partagé
 * profile.service (hors périmètre, comme admin). Le filtre campus est construit
 * par le controller et passé en paramètre.
 */

const Staff = require('./models/staff.model');
const { escapeRegex } = require('../../shared/utils/validation-helpers');

const RESPONSE_SELECT = '-password -__v';
const ROLE_POP = ['subRole', 'name permissions isActive'];

// ── Login ─────────────────────────────────────────────────────────────────────

const findByCredential = (query) =>
  Staff.findOne(query).select('+password').populate(...ROLE_POP).lean({ virtuals: true });

const touchLastLogin = (id) =>
  Staff.findByIdAndUpdate(id, { lastLogin: new Date() }).exec();

// ── CRUD ──────────────────────────────────────────────────────────────────────

/** Creates a staff member (Staff.create → pre('save') hash hook). @returns {Promise<Document>} */
const create = (data) => Staff.create(data);

/** Paginated list (campus + subRole populated). @returns {Promise<{data, total}>} */
const paginate = async ({ campusFilter, status, includeArchived, subRole, search, skip, limit }) => {
  const filter = { ...campusFilter };
  if (status) filter.status = status;
  else if (includeArchived !== true) filter.status = { $ne: 'archived' };
  if (subRole) filter.subRole = subRole;
  if (search) {
    const rx = new RegExp(escapeRegex(search.trim()), 'i');
    filter.$or = [{ firstName: rx }, { lastName: rx }, { email: rx }, { username: rx }];
  }

  const [data, total] = await Promise.all([
    Staff.find(filter)
      .select(RESPONSE_SELECT)
      .populate('schoolCampus', 'campus_name')
      .populate(...ROLE_POP)
      .sort({ createdAt: -1 })
      .skip(skip).limit(limit).lean({ virtuals: true }),
    Staff.countDocuments(filter),
  ]);
  return { data, total };
};

const findOneScoped = (scopeFilter) =>
  Staff.findOne(scopeFilter)
    .select(RESPONSE_SELECT)
    .populate('schoolCampus', 'campus_name')
    .populate(...ROLE_POP)
    .lean({ virtuals: true });

const findOneScopedLean = (scopeFilter) => Staff.findOne(scopeFilter).lean();

const updateScoped = (scopeFilter, body) =>
  Staff.findOneAndUpdate(scopeFilter, { $set: body }, { new: true, runValidators: true })
    .select(RESPONSE_SELECT).populate(...ROLE_POP).lean({ virtuals: true });

const setSubRole = (id, subRoleId) =>
  Staff.findByIdAndUpdate(id, { $set: { subRole: subRoleId } });

const findByIdWithRole = (id) =>
  Staff.findById(id).select(RESPONSE_SELECT).populate(...ROLE_POP).lean({ virtuals: true });

const setStatusScoped = (scopeFilter, status) =>
  Staff.findOneAndUpdate(scopeFilter, { $set: { status } }, { new: true })
    .select(RESPONSE_SELECT).lean({ virtuals: true });

const updatePassword = (id, hashedPassword) =>
  Staff.findByIdAndUpdate(id, { password: hashedPassword });

const deleteById = (id) => Staff.findByIdAndDelete(id);

/** Does any staff member hold this role? (guard for StaffRole deletion). */
const isRoleInUse = (roleId) => Staff.exists({ subRole: roleId });

/** Count of staff on a campus + additional criteria (dashboard). */
const countByCampus = (campusId, criteria = {}) =>
  Staff.countDocuments({ schoolCampus: campusId, ...criteria });

module.exports = {
  findByCredential,
  touchLastLogin,
  create,
  paginate,
  findOneScoped,
  findOneScopedLean,
  updateScoped,
  setSubRole,
  findByIdWithRole,
  setStatusScoped,
  updatePassword,
  deleteById,
  isRoleInUse,
  countByCampus,
};
