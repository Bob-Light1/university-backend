'use strict';

/**
 * @file class.service.js — API inter-modules du domaine class.
 *
 * Exposé :
 *  Lectures :
 *   - countClassesOnCampus       : garde campus en masse (gaet).
 *   - countClasses               : compteur dashboard (campus.controller).
 *   - listClassesForCampus       : listing dashboard (campus.controller).
 *   - resolveClassesForSchedule  : forme dénormalisée classes[] des emplois du
 *     temps (student.schedule.helpers).
 *   - getClassForCourseLink      : validation niveau/campus (subject.course-link).
 *   - getClassForDocumentList    : génération de liste de classe (document.template).
 *   - getClassCampusRef          : validation cross-campus (exam.session, result.crud).
 *   - getClassCampusRefForValidation : validation de classe d'un étudiant (student.config).
 *   - classExistsInCampus        : existence d'une classe gérée (teacher.config).
 *   - findClassManagedBy         : classe actuellement gérée par un teacher (teacher.config).
 *   - findClassForBulk           : entité liée pour GenericBulkController (student.controller).
 *  Mutations (orchestrées par teacher.config) :
 *   - addTeacherToClasses / removeTeacherFromClasses : sync Class.teachers[].
 *   - setClassManager / clearClassManager           : sync Class.classManager.
 */

const Class = require('./class.model');

// ── Lectures ────────────────────────────────────────────────────────────────

/**
 * Compte les classes appartenant à un campus parmi une liste d'ids.
 * @param {string[]} classIds
 * @param {string} campusId
 * @returns {Promise<number>}
 */
const countClassesOnCampus = (classIds, campusId) =>
  Class.countDocuments({ _id: { $in: classIds }, schoolCampus: campusId });

/**
 * Compteur de classes d'un campus.
 * @param {{campusId, status?, excludeArchived?}} params
 * @returns {Promise<number>}
 */
const countClasses = ({ campusId, status, excludeArchived }) => {
  const filter = { schoolCampus: campusId };
  if (status)               filter.status = status;
  else if (excludeArchived) filter.status = { $ne: 'archived' };
  return Class.countDocuments(filter);
};

/**
 * Classes d'un campus (level + classManager peuplés, triées par nom).
 * @param {{campusId, status?}} params
 * @returns {Promise<Array>}
 */
const listClassesForCampus = ({ campusId, status }) => {
  const filter = { schoolCampus: campusId };
  if (status) filter.status = status;
  return Class.find(filter)
    .populate('level',        'name')
    .populate('classManager', 'firstName lastName email profileImage')
    .sort({ className: 1 })
    .lean();
};

/**
 * Resolves an array of classId strings into the denormalised `classes[]` shape
 * expected by StudentSchedule / TeacherSchedule models.
 *
 * Campus isolation: every class must belong to campusId.
 *
 * @param {string[]} classIds
 * @param {string}   campusId
 * @returns {Promise<{
 *   classes: Array<{classId: ObjectId, className: string, level: ObjectId}>,
 *   invalid: string[]
 * }>}
 */
const resolveClassesForSchedule = async (classIds, campusId) => {
  if (!classIds || classIds.length === 0) return { classes: [], invalid: [] };

  const docs = await Class.find({
    _id:          { $in: classIds },
    schoolCampus: campusId,          // campus-isolation guard
    status:       { $ne: 'archived' },
  })
    .select('_id className level')
    .lean();

  const foundIds = new Set(docs.map((d) => d._id.toString()));
  const invalid  = classIds.filter((id) => !foundIds.has(id));

  const classes = docs.map((d) => ({
    classId:   d._id,
    className: d.className,
    level:     d.level ?? null,
  }));

  return { classes, invalid };
};

/**
 * Classe d'un campus pour la validation de liaison Subject↔Course
 * (className + level peuplé).
 * @param {string} classId
 * @param {string|ObjectId} campusId  - schoolCampus attendu (= celui du subject)
 * @returns {Promise<Object|null>}
 */
const getClassForCourseLink = (classId, campusId) =>
  Class.findOne({ _id: classId, schoolCampus: campusId })
    .select('className level schoolCampus')
    .populate('level', 'name')
    .lean();

/**
 * Classe pour la génération d'une liste de classe imprimée.
 *
 * ⚠️ BUG LATENT n°8 (préservé) : la requête filtre sur `campus` et peuple
 * `mainTeacher`, deux champs ABSENTS du schéma Class (les vrais noms sont
 * `schoolCampus` et `classManager`). La requête ne matche donc jamais → le
 * endpoint POST .../class-list répond 404 « Class » en permanence. Comportement
 * conservé tel quel par la migration ; à corriger séparément.
 *
 * @param {string} classId
 * @param {string|ObjectId} campusId
 * @returns {Promise<Object|null>}
 */
const getClassForDocumentList = (classId, campusId) =>
  Class.findOne({ _id: classId, campus: campusId })
    .populate('students', 'firstName lastName gender studentId')
    .populate('mainTeacher', 'firstName lastName')
    .lean();

/**
 * Référence campus d'une classe (validation cross-campus).
 * @param {string} classId
 * @returns {Promise<{_id, schoolCampus}|null>}
 */
const getClassCampusRef = (classId) =>
  Class.findById(classId).select('schoolCampus').lean();

/**
 * Référence campus + nom d'une classe pour la validation de la classe d'un
 * étudiant (supporte une session de transaction).
 * @param {string} classId
 * @param {{session?}} [opts]
 * @returns {Promise<{schoolCampus, className}|null>}
 */
const getClassCampusRefForValidation = (classId, { session } = {}) =>
  Class.findById(classId)
    .select('schoolCampus className')
    .session(session)
    .lean();

/**
 * Existence d'une classe dans un campus (validation d'une classe gérée).
 * @param {string} classId
 * @param {string|ObjectId} campusId
 * @returns {Promise<{_id}|null>}
 */
const classExistsInCampus = (classId, campusId) =>
  Class.findOne({ _id: classId, schoolCampus: campusId }).select('_id').lean();

/**
 * Classe actuellement gérée par un teacher dans un campus.
 * @param {string} teacherId
 * @param {string|ObjectId} campusId
 * @returns {Promise<{_id}|null>}
 */
const findClassManagedBy = (teacherId, campusId) =>
  Class.findOne({ classManager: teacherId, schoolCampus: campusId })
    .select('_id')
    .lean();

/**
 * Nom d'une classe par id (en-têtes d'impression).
 * @param {string} classId
 * @returns {Promise<{className}|null>}
 */
const getClassName = (classId) =>
  Class.findById(classId).select('className').lean();

/**
 * Nom d'une classe d'un campus (en-têtes d'impression, campus-scoped).
 * @param {string} classId
 * @param {string|ObjectId} campusId
 * @returns {Promise<{className}|null>}
 */
const getClassNameInCampus = (classId, campusId) =>
  Class.findOne({ _id: classId, schoolCampus: campusId }).select('className').lean();

/**
 * Entité liée (classe) pour GenericBulkController.bulkChangeRelated
 * (alternative façade-friendly à RelatedModel).
 * @param {string} id
 * @param {ClientSession} [session]
 * @returns {Promise<Document|null>}
 */
const findClassForBulk = (id, session) => Class.findById(id).session(session);

// ── Mutations (orchestrées par teacher.config) ────────────────────────────────

/**
 * Ajoute un teacher au tableau Class.teachers[] des classes données
 * (campus-scoped). No-op si classIds vide.
 */
const addTeacherToClasses = ({ teacherId, classIds, campusId }) => {
  if (!classIds || classIds.length === 0) return Promise.resolve(null);
  return Class.updateMany(
    { _id: { $in: classIds }, schoolCampus: campusId },
    { $addToSet: { teachers: teacherId } }
  );
};

/**
 * Retire un teacher du tableau Class.teachers[] des classes données
 * (campus-scoped). No-op si classIds vide.
 */
const removeTeacherFromClasses = ({ teacherId, classIds, campusId }) => {
  if (!classIds || classIds.length === 0) return Promise.resolve(null);
  return Class.updateMany(
    { _id: { $in: classIds }, schoolCampus: campusId },
    { $pull: { teachers: teacherId } }
  );
};

/**
 * Désigne un teacher comme classManager d'une classe (campus-scoped).
 */
const setClassManager = ({ classId, teacherId, campusId }) =>
  Class.updateOne(
    { _id: classId, schoolCampus: campusId },
    { $set: { classManager: teacherId } }
  );

/**
 * Retire le classManager d'une classe, uniquement si c'est bien `teacherId`
 * qui l'occupe (campus-scoped) — évite d'écraser un autre manager.
 */
const clearClassManager = ({ classId, teacherId, campusId }) =>
  Class.updateOne(
    { _id: classId, classManager: teacherId, schoolCampus: campusId },
    { $set: { classManager: null } }
  );

module.exports = {
  countClassesOnCampus,
  countClasses,
  listClassesForCampus,
  resolveClassesForSchedule,
  getClassForCourseLink,
  getClassForDocumentList,
  getClassCampusRef,
  getClassCampusRefForValidation,
  getClassName,
  getClassNameInCampus,
  classExistsInCampus,
  findClassManagedBy,
  findClassForBulk,
  addTeacherToClasses,
  removeTeacherFromClasses,
  setClassManager,
  clearClassManager,
};
