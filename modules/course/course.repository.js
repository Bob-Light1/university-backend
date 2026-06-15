'use strict';

/**
 * @file course.repository.js — couche de persistance du domaine course.
 *
 * SEUL fichier du module autorisé à toucher le model Course (controllers crud/
 * workflow/resources + service). Étape 0 de la préparation Postgres — voir
 * POSTGRES_MIGRATION_ASSESSMENT.md §7.
 *
 * Conventions :
 *  - Lectures → objets simples (`.lean({ virtuals: true })` là où les virtuals
 *    totalHours/prerequisiteCount sont attendus).
 *  - Écritures → load→mutate→save : le model a des hooks pre('validate')/pre('save')
 *    (slug, BFS anti-cycle des prérequis, validation MIME des ressources) que
 *    findByIdAndUpdate court-circuiterait.
 *  - La transaction de versioning (startSession/withTransaction) vit ICI.
 *  - Les filtres dynamiques (buildCourseFilter) restent construits par les
 *    controllers via course.helper et passés en paramètre — frontière DAO.
 */

const mongoose = require('mongoose');
const { Course, APPROVAL_STATUS } = require('./course.model');
const { COURSE_POPULATE } = require('./controllers/course.helper');

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ACTIVE = { $ne: 'archived' };

// ── Lectures ─────────────────────────────────────────────────────────────────

/** Nombre de cours actifs parmi une liste d'ids (validation des prérequis). */
const countExistingActive = (ids) =>
  Course.countDocuments({ _id: { $in: ids }, status: ACTIVE });

/**
 * Liste paginée (filtre fourni par le controller), populate LIST, virtuals.
 * @returns {Promise<{data: Object[], total: number}>}
 */
const paginateList = async ({ filter, sort, skip, limit }) => {
  const [data, total] = await Promise.all([
    Course.find(filter).sort(sort).skip(skip).limit(limit)
      .populate(COURSE_POPULATE.LIST).lean({ virtuals: true }),
    Course.countDocuments(filter),
  ]);
  return { data, total };
};

/** Détail d'un cours actif (populate DETAIL, virtuals). */
const findActiveByIdDetailed = (id) =>
  Course.findOne({ _id: id, status: ACTIVE }).populate(COURSE_POPULATE.DETAIL).lean({ virtuals: true });

/** Lecture brute d'un cours actif (préconditions : approvalStatus, resources…). */
const findActiveByIdLean = (id) =>
  Course.findOne({ _id: id, status: ACTIVE }).lean();

/** Dernière version active par code (populate DETAIL, virtuals). */
const findLatestActiveByCode = (code) =>
  Course.findOne({ courseCode: code, isLatestVersion: true, status: ACTIVE })
    .populate(COURSE_POPULATE.DETAIL).lean({ virtuals: true });

/** Code d'un cours actif (résolution de l'historique de versions). */
const findCodeById = (id) =>
  Course.findOne({ _id: id, status: ACTIVE }).select('courseCode').lean();

/** Dernière version active (lecture brute) — préalable au versioning. */
const findLatestActiveLean = (id) =>
  Course.findOne({ _id: id, status: ACTIVE, isLatestVersion: true }).lean();

/**
 * Historique de versions paginé (même courseCode), tri version desc.
 * @returns {Promise<{data: Object[], total: number}>}
 */
const paginateVersions = async (courseCode, { skip, limit }) => {
  const filter = { courseCode, status: ACTIVE };
  const [data, total] = await Promise.all([
    Course.find(filter).sort({ version: -1 }).skip(skip).limit(limit)
      .populate([
        { path: 'createdBy',             select: 'firstName lastName' },
        { path: 'approvalHistory.actor', select: 'firstName lastName' },
      ])
      .lean({ virtuals: true }),
    Course.countDocuments(filter),
  ]);
  return { data, total };
};

/** Cours actifs référençant `id` en prérequis (avertissement non bloquant). */
const listDependents = (id) =>
  Course.find({ 'prerequisites.course': id, status: ACTIVE })
    .select('courseCode title version approvalStatus').lean();

// ── Écritures (load→mutate→save, hooks préservés) ──────────────────────────────

/** Crée un cours et peuple level + createdBy pour la réponse. @returns {Promise<Document>} */
const create = async (data) => {
  const course = await Course.create(data);
  await course.populate([
    { path: 'level',     select: 'name description' },
    { path: 'createdBy', select: 'firstName lastName' },
  ]);
  return course;
};

/** Applique des champs à un cours actif, save + populate DETAIL. @returns {Promise<Document|null>} */
const applyUpdate = async (id, updates) => {
  const course = await Course.findOne({ _id: id, status: ACTIVE });
  if (!course) return null;
  Object.assign(course, updates);
  await course.save();
  await course.populate(COURSE_POPULATE.DETAIL);
  return course;
};

/** Soft-delete (archive) d'un cours actif. @returns {Promise<Document|null>} */
const archiveById = async (id, { deletedBy }) => {
  const course = await Course.findOne({ _id: id, status: ACTIVE });
  if (!course) return null;
  course.status    = 'archived';
  course.deletedAt = new Date();
  course.deletedBy = deletedBy;
  await course.save();
  return course;
};

/** Restaure un cours archivé. @returns {Promise<Document|null>} */
const restoreById = async (id) => {
  const course = await Course.findOne({ _id: id, status: 'archived' });
  if (!course) return null;
  course.status    = 'active';
  course.deletedAt = undefined;
  course.deletedBy = undefined;
  await course.save();
  return course;
};

/**
 * Applique une transition de statut d'approbation + entrée d'historique.
 * @returns {Promise<Document|null>}
 */
const applyStatusTransition = async (id, { newStatus, historyEntry }) => {
  const course = await Course.findOne({ _id: id, status: ACTIVE });
  if (!course) return null;
  course.approvalStatus = newStatus;
  course.approvalHistory.push(historyEntry);
  await course.save();
  await course.populate(COURSE_POPULATE.DETAIL);
  return course;
};

/**
 * Ajoute une ressource au cours actif (save → déclenche la validation MIME).
 * @returns {Promise<Object|null>} la ressource ajoutée, ou null si cours introuvable
 */
const pushResource = async (id, entry) => {
  const course = await Course.findOne({ _id: id, status: ACTIVE });
  if (!course) return null;
  course.resources.push(entry);
  await course.save();
  return course.resources[course.resources.length - 1];
};

/**
 * Retire une ressource (par sous-doc id) du cours actif.
 * @returns {Promise<boolean|null>} true si retirée, null si cours introuvable
 */
const pullResource = async (id, resourceId) => {
  const course = await Course.findOne({ _id: id, status: ACTIVE });
  if (!course) return null;
  course.resources = course.resources.filter((r) => r._id.toString() !== resourceId);
  await course.save();
  return true;
};

/**
 * Clone un cours APPROVED en nouvelle version DRAFT (transaction atomique :
 * retire l'ancienne latest + insère la nouvelle). Possède la session Mongoose.
 * @param {{ original: Object, actorId: string, copyResources: boolean }} p
 * @returns {Promise<Document>} le nouveau cours, populé DETAIL
 * @throws {Error & { statusCode: 409 }} si le statut a changé en concurrence
 */
const cloneAsNewVersion = async ({ original, actorId, copyResources }) => {
  const dbSession = await mongoose.startSession();
  let newCourse;
  try {
    await dbSession.withTransaction(async () => {
      // Re-vérif sous transaction — garde contre un approve/reject concurrent.
      const locked = await Course.findOne(
        { _id: original._id, approvalStatus: APPROVAL_STATUS.APPROVED, isLatestVersion: true },
        null,
        { session: dbSession },
      ).lean();

      if (!locked) {
        throw Object.assign(
          new Error('Course status changed concurrently. Please refresh and retry.'),
          { statusCode: 409 },
        );
      }

      await Course.findByIdAndUpdate(original._id, { isLatestVersion: false }, { session: dbSession });

      const {
        _id, __v, createdAt, updatedAt,
        slug, approvalStatus, approvalHistory, isLatestVersion, version, resources,
        ...cloneData
      } = original;

      const initNote = copyResources
        ? `New version v${version + 1} created from v${version} (resources copied)`
        : `New version v${version + 1} created from v${version} (resources not copied)`;

      const [created] = await Course.create(
        [
          {
            ...cloneData,
            resources:       copyResources ? (resources || []) : [],
            version:         version + 1,
            parentCourseId:  original._id,
            isLatestVersion: true,
            approvalStatus:  APPROVAL_STATUS.DRAFT,
            approvalHistory: [
              { status: APPROVAL_STATUS.DRAFT, note: initNote, actor: actorId, actedAt: new Date() },
            ],
            createdBy: actorId,
          },
        ],
        { session: dbSession },
      );

      newCourse = created;
    });
  } finally {
    await dbSession.endSession();
  }

  await newCourse.populate(COURSE_POPULATE.DETAIL);
  return newCourse;
};

// ── API inter-modules (ancien course.service) ──────────────────────────────────

/** Catalogue paginé des cours APPROVED (staff/mentor). @returns {Promise<{docs, total}>} */
const listApproved = async ({ search, page = 1, limit = 20 } = {}) => {
  const filter = {
    approvalStatus:  APPROVAL_STATUS.APPROVED,
    isLatestVersion: true,
    status:          ACTIVE,
  };
  if (search) {
    const rx = new RegExp(escapeRegex(search.trim()), 'i');
    filter.$or = [{ title: rx }, { courseCode: rx }, { description: rx }];
  }
  const skip = (Number(page) - 1) * Number(limit);
  const [docs, total] = await Promise.all([
    Course.find(filter).select('-__v')
      .populate('subject', 'subject_name').populate('createdBy', 'firstName lastName')
      .sort({ title: 1 }).skip(skip).limit(Number(limit)).lean(),
    Course.countDocuments(filter),
  ]);
  return { docs, total };
};

/** Vrai si l'enseignant possède au moins un des cours (contrôle d'accès document). */
const teacherOwnsAnyCourse = async (courseIds, teacherId) => {
  const owned = await Course.findOne({ _id: { $in: courseIds }, teacher: teacherId }).select('_id').lean();
  return owned != null;
};

/** Cours éligible au lien Subject→Course (level populé). */
const findApprovedForLinking = (courseId) =>
  Course.findOne({
    _id: courseId, status: ACTIVE,
    approvalStatus: APPROVAL_STATUS.APPROVED, isLatestVersion: true,
  }).populate('level', 'name').lean();

module.exports = {
  countExistingActive,
  paginateList,
  findActiveByIdDetailed,
  findActiveByIdLean,
  findLatestActiveByCode,
  findCodeById,
  findLatestActiveLean,
  paginateVersions,
  listDependents,
  create,
  applyUpdate,
  archiveById,
  restoreById,
  applyStatusTransition,
  pushResource,
  pullResource,
  cloneAsNewVersion,
  listApproved,
  teacherOwnsAnyCourse,
  findApprovedForLinking,
};
