'use strict';

/**
 * @file parent.repository.js — couche de persistance du domaine parent.
 *
 * SEUL fichier du module autorisé à interroger le model Parent (auth, crud,
 * analytics, portal, service). Étape 0 de la préparation Postgres — voir
 * POSTGRES_MIGRATION_ASSESSMENT.md §7.
 *
 * Le model a un hook pre('save') (hash) + pre('validate') → la création passe
 * par Parent.create. Le filtre campus (isolation multi-tenant) est construit par
 * les controllers et passé en paramètre.
 */

const mongoose = require('mongoose');
const Parent = require('./parent.model');

const RESPONSE_SELECT = '-password -__v';
const NO_NOTES_SELECT = '-password -__v -notes';
const NOT_ARCHIVED = { $ne: 'archived' };

// Cast schoolCampus → ObjectId for aggregation pipelines ($match strict mode).
const castCampus = (filter) => {
  if (!filter.schoolCampus) return filter;
  return { ...filter, schoolCampus: new mongoose.Types.ObjectId(String(filter.schoolCampus)) };
};

// ── Auth ──────────────────────────────────────────────────────────────────────

const findByCredential = (query) =>
  Parent.findOne(query).select('+password').lean({ virtuals: true });

const touchLastLogin = (id) =>
  Parent.findByIdAndUpdate(id, { lastLogin: new Date() }).exec();

const findByIdForProfile = (id) =>
  Parent.findById(id)
    .select(NO_NOTES_SELECT)
    .populate('schoolCampus', 'campus_name location')
    .populate('children', 'firstName lastName profileImage studentClass status')
    .lean({ virtuals: true });

const findByIdWithPassword = (id) => Parent.findById(id).select('+password').lean();

const updatePassword = (id, hashedPassword) =>
  Parent.findByIdAndUpdate(id, { password: hashedPassword });

const updateOwnProfile = (id, updates) =>
  Parent.findByIdAndUpdate(id, { $set: updates }, { new: true, runValidators: true })
    .select(NO_NOTES_SELECT).populate('schoolCampus', 'campus_name').lean({ virtuals: true });

const updateProfileImage = (id, url) =>
  Parent.findByIdAndUpdate(id, { $set: { profileImage: url } }, { new: true })
    .select('_id firstName lastName profileImage').lean({ virtuals: true });

// ── CRUD ──────────────────────────────────────────────────────────────────────

/** Creates a parent (Parent.create → pre-save/validate hooks). @returns {Promise<Document>} */
const create = (data) => Parent.create(data);

const findByIdForResponse = (id) =>
  Parent.findById(id)
    .select(RESPONSE_SELECT)
    .populate('schoolCampus', 'campus_name')
    .populate('children', 'firstName lastName')
    .lean({ virtuals: true });

/**
 * Liste paginée admin. Les valeurs (status/relationship/campusIdOverride) sont
 * déjà validées par le controller.
 * @returns {Promise<{data, total}>}
 */
const paginate = async ({ campusFilter, includeArchived, campusIdOverride, status, relationship, search, skip, limit }) => {
  const filter = { ...campusFilter, ...(includeArchived ? {} : { status: NOT_ARCHIVED }) };
  if (campusIdOverride) filter.schoolCampus = campusIdOverride;
  if (status) filter.status = status;
  if (relationship) filter.relationship = relationship;
  if (search) {
    const rx = new RegExp(search.trim(), 'i');
    filter.$or = [{ firstName: rx }, { lastName: rx }, { email: rx }, { parentRef: rx }];
  }

  const [data, total] = await Promise.all([
    Parent.find(filter)
      .select(NO_NOTES_SELECT)
      .populate('schoolCampus', 'campus_name')
      .populate('children', 'firstName lastName profileImage')
      .sort({ createdAt: -1 }).skip(skip).limit(limit).lean({ virtuals: true }),
    Parent.countDocuments(filter),
  ]);
  return { data, total };
};

const findScopedDetailed = (id, campusFilter) =>
  Parent.findOne({ _id: id, ...campusFilter })
    .select(RESPONSE_SELECT)
    .populate('schoolCampus', 'campus_name location')
    .populate('children', 'firstName lastName profileImage studentClass status')
    .lean({ virtuals: true });

const updateScoped = (id, campusFilter, updates) =>
  Parent.findOneAndUpdate(
    { _id: id, ...campusFilter, status: NOT_ARCHIVED },
    { $set: updates },
    { new: true, runValidators: true },
  ).select(RESPONSE_SELECT).populate('schoolCampus', 'campus_name').populate('children', 'firstName lastName').lean({ virtuals: true });

const setStatusScoped = (id, campusFilter, status) =>
  Parent.findOneAndUpdate(
    { _id: id, ...campusFilter, status: NOT_ARCHIVED },
    { $set: { status } },
    { new: true },
  ).select(NO_NOTES_SELECT).lean({ virtuals: true });

/** Active parent within the scope (preconditions: _id, schoolCampus). */
const findActiveScoped = (id, campusFilter) =>
  Parent.findOne({ _id: id, ...campusFilter, status: NOT_ARCHIVED }).lean();

const setChildren = (id, children) =>
  Parent.findByIdAndUpdate(id, { $set: { children } }, { new: true, runValidators: true })
    .select(NO_NOTES_SELECT).populate('children', 'firstName lastName profileImage').lean({ virtuals: true });

const hardDeleteScoped = (id, campusFilter) =>
  Parent.findOneAndDelete({ _id: id, ...campusFilter });

const archiveScoped = (id, campusFilter) =>
  Parent.findOneAndUpdate({ _id: id, ...campusFilter, status: NOT_ARCHIVED }, { $set: { status: 'archived' } }, { new: true });

const restoreScoped = (id, campusFilter) =>
  Parent.findOneAndUpdate({ _id: id, ...campusFilter, status: 'archived' }, { $set: { status: 'active' } }, { new: true });

// ── Analytics ─────────────────────────────────────────────────────────────────

const aggregateStatusBreakdown = (campusFilter) =>
  Parent.aggregate([
    { $match: { ...castCampus(campusFilter), status: NOT_ARCHIVED } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

const aggregateRelationshipBreakdown = (campusFilter) =>
  Parent.aggregate([
    { $match: { ...castCampus(campusFilter), status: NOT_ARCHIVED } },
    { $group: { _id: '$relationship', count: { $sum: 1 } } },
  ]);

const aggregateGenderBreakdown = (campusFilter) =>
  Parent.aggregate([
    { $match: { ...castCampus(campusFilter), status: NOT_ARCHIVED } },
    { $group: { _id: '$gender', count: { $sum: 1 } } },
  ]);

const aggregateChildrenDistribution = (campusFilter) =>
  Parent.aggregate([
    { $match: { ...castCampus(campusFilter), status: NOT_ARCHIVED } },
    { $group: { _id: { $size: '$children' }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);

const aggregateMonthlyRegistrations = (campusFilter, sinceDate) =>
  Parent.aggregate([
    { $match: { ...castCampus(campusFilter), createdAt: { $gte: sinceDate } } },
    { $group: { _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } }, count: { $sum: 1 } } },
    { $sort: { '_id.year': 1, '_id.month': 1 } },
  ]);

const countRecent = (campusFilter, sinceDate) =>
  Parent.countDocuments({ ...campusFilter, status: NOT_ARCHIVED, createdAt: { $gte: sinceDate } });

const countArchived = (campusFilter) =>
  Parent.countDocuments({ ...campusFilter, status: 'archived' });

const findByStudent = (campusFilter, studentId) =>
  Parent.find({ ...campusFilter, children: studentId, status: NOT_ARCHIVED })
    .select(NO_NOTES_SELECT).populate('schoolCampus', 'campus_name location').lean({ virtuals: true });

// ── Portal ────────────────────────────────────────────────────────────────────

const findOwnership = (id) => Parent.findById(id).select('schoolCampus children').lean();

const findChildren = (id) =>
  Parent.findById(id)
    .select('children schoolCampus')
    .populate('children', 'firstName lastName profileImage studentClass status schoolCampus')
    .lean({ virtuals: true });

const findForDashboard = (id) =>
  Parent.findById(id)
    .select('children schoolCampus firstName lastName')
    .populate('children', 'firstName lastName profileImage studentClass status')
    .lean({ virtuals: true });

// ── Service (API inter-modules) ───────────────────────────────────────────────

/** Retire studentId de children[] chez tous les parents (hook hard-delete student). */
const removeChildFromAll = (studentId) =>
  Parent.updateMany({ children: studentId }, { $pull: { children: studentId } }).exec();

module.exports = {
  findByCredential,
  touchLastLogin,
  findByIdForProfile,
  findByIdWithPassword,
  updatePassword,
  updateOwnProfile,
  updateProfileImage,
  create,
  findByIdForResponse,
  paginate,
  findScopedDetailed,
  updateScoped,
  setStatusScoped,
  findActiveScoped,
  setChildren,
  hardDeleteScoped,
  archiveScoped,
  restoreScoped,
  aggregateStatusBreakdown,
  aggregateRelationshipBreakdown,
  aggregateGenderBreakdown,
  aggregateChildrenDistribution,
  aggregateMonthlyRegistrations,
  countRecent,
  countArchived,
  findByStudent,
  findOwnership,
  findChildren,
  findForDashboard,
  removeChildFromAll,
};
