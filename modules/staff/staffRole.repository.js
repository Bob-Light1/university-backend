'use strict';

/**
 * @file staffRole.repository.js — couche de persistance du model StaffRole.
 *
 * SEUL fichier autorisé à interroger StaffRole. Étape 0 de la préparation
 * Postgres — voir POSTGRES_MIGRATION_ASSESSMENT.md §7.
 *
 * StaffRole utilise la clé `campus` (et non `schoolCampus`). Le controller
 * dérive un `campusScope` (= campusId, ou null pour ADMIN/DIRECTOR global) et le
 * passe ; le repo construit le filtre `{ campus }` quand il est fourni.
 */

const StaffRole = require('./models/staffRole.model');

const scopeFilter = (id, campusScope) => {
  const f = { _id: id };
  if (campusScope) f.campus = campusScope;
  return f;
};

/** Active role on a campus (assignment validation on the staff side). */
const findActiveInCampus = (roleId, campusId) =>
  StaffRole.findOne({ _id: roleId, campus: campusId, isActive: true }).lean();

const create = (data) => StaffRole.create(data);

/** Paginated list (campus populated). @returns {Promise<{data, total}>} */
const paginate = async ({ campusScope, isActive, search, skip, limit }) => {
  const filter = {};
  if (campusScope) filter.campus = campusScope;
  if (isActive !== undefined) filter.isActive = isActive;
  if (search) {
    const rx = new RegExp(search.trim(), 'i');
    filter.$or = [{ name: rx }, { description: rx }];
  }

  const [data, total] = await Promise.all([
    StaffRole.find(filter).populate('campus', 'campus_name').sort({ name: 1 }).skip(skip).limit(limit).lean(),
    StaffRole.countDocuments(filter),
  ]);
  return { data, total };
};

const findOneScoped = (roleId, campusScope) =>
  StaffRole.findOne(scopeFilter(roleId, campusScope)).populate('campus', 'campus_name').lean();

/** Raw scoped read (preconditions for toggle/delete: _id, isActive). */
const findScopedRaw = (roleId, campusScope) =>
  StaffRole.findOne(scopeFilter(roleId, campusScope)).lean();

const updateScoped = (roleId, campusScope, updates) =>
  StaffRole.findOneAndUpdate(scopeFilter(roleId, campusScope), { $set: updates }, { new: true, runValidators: true })
    .populate('campus', 'campus_name').lean();

/** Activates/deactivates a role (no hook → findByIdAndUpdate is faithful). */
const setActive = (id, isActive) =>
  StaffRole.findByIdAndUpdate(id, { $set: { isActive } }, { new: true }).lean();

const deleteById = (id) => StaffRole.findByIdAndDelete(id);

module.exports = {
  findActiveInCampus,
  create,
  paginate,
  findOneScoped,
  findScopedRaw,
  updateScoped,
  setActive,
  deleteById,
};
