'use strict';

/**
 * @file class.repository.js — couche de persistance du domaine class.
 *
 * SEUL fichier du module autorisé à interroger le model Class (controller +
 * service inter-modules). Étape 0 de la préparation Postgres — voir
 * POSTGRES_MIGRATION_ASSESSMENT.md §7.
 *
 * Le model a un hook pre('validate') (validation classManager ↔ campus) : la
 * création passe par Class.create et les mutations par load→save. Le filtre
 * campus est construit par le controller et passé en paramètre.
 */

const Class = require('./class.model');
const { escapeRegex } = require('../../shared/utils/validation-helpers');

// Populate presets (exact fields preserved by handler).
const POP_FULL = (q) => q
  .populate('schoolCampus', 'campus_name')
  .populate('level', 'name description')
  .populate('classManager', 'firstName lastName email');

// ── Controller : CRUD ─────────────────────────────────────────────────────────

/** Doublon (campus + niveau + nom), optionnellement hors un id. */
const findDuplicate = ({ schoolCampus, level, className, exceptId }) => {
  const filter = { schoolCampus, level, className };
  if (exceptId) filter._id = { $ne: exceptId };
  return Class.findOne(filter);
};

/** Creates a class (Class.create → pre-validate hook). @returns {Promise<Document>} */
const create = (data) => Class.create(data);

/** Raw read (preconditions for update/delete/restore). */
const findByIdLean = (id) => Class.findById(id).lean();

/** Standard response (campus_name + level + classManager). */
const findByIdPopulated = (id) =>
  POP_FULL(Class.findById(id)).lean();

/** Detailed single view (extended campus + students). */
const findByIdDetailed = (id) =>
  Class.findById(id)
    .populate('schoolCampus', 'campus_name campus_number location')
    .populate('level', 'name description')
    .populate('classManager', 'firstName lastName email phone')
    .populate('students', 'firstName lastName email')
    .lean();

/** Restore response (campus_name + level only). */
const findByIdForRestore = (id) =>
  Class.findById(id)
    .populate('schoolCampus', 'campus_name')
    .populate('level', 'name description')
    .lean();

/**
 * Liste paginée (getAllClass). Filtre campus + archived/status/level/recherche.
 * @returns {Promise<{data, total}>}
 */
const paginate = async ({ baseFilter, includeArchived, status, level, search, skip, limit }) => {
  const filter = { ...baseFilter };
  if (!includeArchived) filter.status = { $ne: 'archived' };
  else if (status) filter.status = status;
  if (level) filter.level = level;
  if (search) filter.className = { $regex: escapeRegex(search), $options: 'i' };

  const [data, total] = await Promise.all([
    POP_FULL(Class.find(filter)).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Class.countDocuments(filter),
  ]);
  return { data, total };
};

/**
 * Classes d'un campus (getClassesByCampus). Par défaut status='active'.
 * @returns {Promise<Array>}
 */
const listByCampus = ({ campusId, status, includeArchived, search, level }) => {
  const filter = { schoolCampus: campusId };
  if (!includeArchived) filter.status = 'active';
  else if (status) filter.status = status;
  if (search) filter.className = { $regex: escapeRegex(search), $options: 'i' };
  if (level) filter.level = level;

  return Class.find(filter)
    .populate('schoolCampus', 'campus_name email')
    .populate('level', 'name description')
    .populate('classManager', 'firstName lastName email')
    .sort({ level: 1, className: 1 })
    .lean();
};

/** Classes belonging to a teacher (classManager OR teachers[]), campus-scoped. */
const listByTeacher = ({ campusFilter, teacherId }) => {
  const filter = {
    ...campusFilter,
    status: { $ne: 'archived' },
    $or: [{ classManager: teacherId }, { teachers: teacherId }],
  };
  return POP_FULL(Class.find(filter)).sort({ className: 1 }).lean();
};

/** Applies fields (load→assign→save, preserves pre-validate). @returns {Promise<Document|null>} */
const applyUpdate = async (id, fields) => {
  const klass = await Class.findById(id);
  if (!klass) return null;
  Object.assign(klass, fields);
  await klass.save();
  return klass;
};

/** Change le statut (load→save). @returns {Promise<Document|null>} */
const setStatus = async (id, status) => {
  const klass = await Class.findById(id);
  if (!klass) return null;
  klass.status = status;
  await klass.save();
  return klass;
};

// ── Service inter-modules ─────────────────────────────────────────────────────

const countOnCampus = (classIds, campusId) =>
  Class.countDocuments({ _id: { $in: classIds }, schoolCampus: campusId });

const countByCampus = ({ campusId, status, excludeArchived }) => {
  const filter = { schoolCampus: campusId };
  if (status) filter.status = status;
  else if (excludeArchived) filter.status = { $ne: 'archived' };
  return Class.countDocuments(filter);
};

const listForCampusDashboard = ({ campusId, status }) => {
  const filter = { schoolCampus: campusId };
  if (status) filter.status = status;
  return Class.find(filter)
    .populate('level', 'name')
    .populate('classManager', 'firstName lastName email profileImage')
    .sort({ className: 1 })
    .lean();
};

const resolveForSchedule = async (classIds, campusId) => {
  if (!classIds || classIds.length === 0) return { classes: [], invalid: [] };
  const docs = await Class.find({
    _id: { $in: classIds }, schoolCampus: campusId, status: { $ne: 'archived' },
  }).select('_id className level').lean();

  const foundIds = new Set(docs.map((d) => d._id.toString()));
  const invalid = classIds.filter((id) => !foundIds.has(id));
  const classes = docs.map((d) => ({ classId: d._id, className: d.className, level: d.level ?? null }));
  return { classes, invalid };
};

const findForCourseLink = (classId, campusId) =>
  Class.findOne({ _id: classId, schoolCampus: campusId })
    .select('className level schoolCampus').populate('level', 'name').lean();

const findForDocumentList = (classId, campusId) =>
  Class.findOne({ _id: classId, schoolCampus: campusId }).select('className schoolCampus').lean();

const getCampusRef = (classId) => Class.findById(classId).select('schoolCampus').lean();

const getCampusRefForValidation = (classId, { session } = {}) =>
  Class.findById(classId).select('schoolCampus className').session(session).lean();

/** Campus refs for a batch of classes (batch validation classes∈campus — teacher.config). */
const getCampusRefsByIds = (classIds, { session } = {}) =>
  Class.find({ _id: { $in: classIds } }).select('schoolCampus').session(session).lean();

const existsInCampus = (classId, campusId) =>
  Class.findOne({ _id: classId, schoolCampus: campusId }).select('_id').lean();

const findManagedBy = (teacherId, campusId) =>
  Class.findOne({ classManager: teacherId, schoolCampus: campusId }).select('_id').lean();

/** True if `teacherId` is the manager of, or assigned to, `classId` in the campus. */
const teacherInClass = ({ classId, teacherId, campusId }) =>
  Class.exists({
    _id:          classId,
    schoolCampus: campusId,
    $or:          [{ classManager: teacherId }, { teachers: teacherId }],
  });

const getName = (classId) => Class.findById(classId).select('className').lean();

const getNameInCampus = (classId, campusId) =>
  Class.findOne({ _id: classId, schoolCampus: campusId }).select('className').lean();

const findForBulk = (id, session) => Class.findById(id).session(session);

const addTeacherToClasses = ({ teacherId, classIds, campusId }) => {
  if (!classIds || classIds.length === 0) return Promise.resolve(null);
  return Class.updateMany({ _id: { $in: classIds }, schoolCampus: campusId }, { $addToSet: { teachers: teacherId } });
};

const removeTeacherFromClasses = ({ teacherId, classIds, campusId }) => {
  if (!classIds || classIds.length === 0) return Promise.resolve(null);
  return Class.updateMany({ _id: { $in: classIds }, schoolCampus: campusId }, { $pull: { teachers: teacherId } });
};

const setClassManager = ({ classId, teacherId, campusId }) =>
  Class.updateOne({ _id: classId, schoolCampus: campusId }, { $set: { classManager: teacherId } });

const clearClassManager = ({ classId, teacherId, campusId }) =>
  Class.updateOne({ _id: classId, classManager: teacherId, schoolCampus: campusId }, { $set: { classManager: null } });

module.exports = {
  // controller
  findDuplicate, create, findByIdLean, findByIdPopulated, findByIdDetailed,
  findByIdForRestore, paginate, listByCampus, listByTeacher, applyUpdate, setStatus,
  // service
  countOnCampus, countByCampus, listForCampusDashboard, resolveForSchedule,
  findForCourseLink, findForDocumentList, getCampusRef, getCampusRefForValidation,
  getCampusRefsByIds,
  existsInCampus, findManagedBy, teacherInClass, getName, getNameInCampus, findForBulk,
  addTeacherToClasses, removeTeacherFromClasses, setClassManager, clearClassManager,
};
