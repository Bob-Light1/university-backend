'use strict';

/**
 * @file announcement.repository.js — couche de persistance du domaine announcement.
 *
 * SEUL fichier du module autorisé à toucher les models Announcement &
 * UserNotification. Controllers et service appellent ce repository.
 * Étape 0 de la préparation Postgres — voir POSTGRES_MIGRATION_ASSESSMENT.md §7.
 *
 * Les filtres Mongo (isolation campus, visibilité, soft-delete) sont construits
 * ICI à partir de paramètres de domaine — la couche HTTP n'écrit plus de requête
 * Mongoose. Lectures en `.lean()` ; écritures par load→mutate→save (préserve les
 * setters/validations du schéma).
 */

const Announcement     = require('./models/announcement.model');
const UserNotification = require('./models/user-notification.model');
const { escapeRegex, isValidObjectId } = require('../../shared/utils/validation-helpers');

// ── Constructeurs de filtres internes ─────────────────────────────────────────

/**
 * Guards against a campus-isolation breach: a scoped role with a missing or
 * invalid campusId would yield `{ schoolCampus: undefined }`, which Mongoose
 * silently strips — turning a campus-scoped query into a full-collection scan
 * that leaks every campus' data. Throw instead so the caller returns 403.
 * @throws {Error} code 'CAMPUS_ISOLATION' when campusId is missing/invalid
 */
const requireCampus = (campusId) => {
  if (!isValidObjectId(String(campusId))) {
    const err = new Error('Campus isolation: missing or invalid campusId for scoped role.');
    err.code = 'CAMPUS_ISOLATION';
    throw err;
  }
  return campusId;
};

// Admin scope: all (ADMIN/DIRECTOR) or own campus, excluding deleted.
const adminScope = ({ isGlobalRole, campusId, requestedCampusId }) => {
  const filter = { deletedAt: null };
  if (!isGlobalRole) {
    filter.schoolCampus = requireCampus(campusId);
  } else if (requestedCampusId && isValidObjectId(String(requestedCampusId))) {
    // ADMIN/DIRECTOR may narrow to one campus; ignore malformed input rather
    // than letting it reach Mongoose as a CastError.
    filter.schoolCampus = requestedCampusId;
  }
  return filter;
};

// User-visible scope: published, not expired, targeting their role.
const visibleScope = (campusId, role) => ({
  schoolCampus: requireCampus(campusId),
  status:       'published',
  deletedAt:    null,
  $and: [
    { $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] },
    { $or: [{ targetRoles: role }, { targetRoles: 'ALL' }] },
  ],
});

// ── ADMIN ─────────────────────────────────────────────────────────────────────

const create = (data) => Announcement.create(data);

/**
 * Liste paginée pour l'admin (tri épinglé d'abord, puis récent).
 * @returns {Promise<{data: Object[], total: number}>}
 */
const paginateForAdmin = async ({
  isGlobalRole, campusId, requestedCampusId,
  status, type, targetRole, pinned, search, skip, limit,
}) => {
  const filter = adminScope({ isGlobalRole, campusId, requestedCampusId });
  if (status)              filter.status      = status;
  if (type)                filter.type        = type;
  if (targetRole)          filter.targetRoles = targetRole;
  if (pinned !== undefined) filter.pinned     = pinned;
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ title: rx }, { content: rx }];
  }

  const [data, total] = await Promise.all([
    Announcement.find(filter).sort({ pinned: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
    Announcement.countDocuments(filter),
  ]);
  return { data, total };
};

/** Read an announcement within the admin scope. */
const findForAdmin = ({ id, isGlobalRole, campusId }) =>
  Announcement.findOne({ _id: id, ...adminScope({ isGlobalRole, campusId }) }).lean();

/**
 * Applique des champs à une annonce (load→assign→save, dans la portée admin).
 * Préserve les validations du schéma et propage les ValidationError à l'appelant.
 * @returns {Promise<Object|null>} doc mis à jour, ou null si introuvable/hors portée
 */
const applyUpdate = async ({ id, isGlobalRole, campusId }, fields) => {
  const doc = await Announcement.findOne({ _id: id, ...adminScope({ isGlobalRole, campusId }) });
  if (!doc) return null;
  Object.assign(doc, fields);
  await doc.save();
  return doc;
};

// ── USER (visible announcements + read receipts) ──────────────────────────────

/**
 * Read-announcement ids restricted to a bounded set of candidates.
 * Scopes the receipt scan to the page / visible set instead of every receipt
 * the user ever created (which grows unbounded over the account's lifetime).
 * @returns {Promise<ObjectId[]>}
 */
const listReadAmong = async (userId, announcementIds) => {
  if (!announcementIds || announcementIds.length === 0) return [];
  const receipts = await UserNotification
    .find({ userId, announcement: { $in: announcementIds } })
    .select('announcement').lean();
  return receipts.map((r) => r.announcement);
};

/**
 * Liste paginée des annonces visibles par l'utilisateur (épinglé puis récent).
 * `excludeIds` permet le filtre "non lues".
 * @returns {Promise<{data: Object[], total: number}>}
 */
const paginateVisible = async ({ campusId, role, type, excludeIds, skip, limit }) => {
  const filter = visibleScope(campusId, role);
  if (type) filter.type = type;
  if (excludeIds) filter._id = { $nin: excludeIds };

  const [data, total] = await Promise.all([
    Announcement.find(filter).sort({ pinned: -1, publishedAt: -1 }).skip(skip).limit(limit).lean(),
    Announcement.countDocuments(filter),
  ]);
  return { data, total };
};

/** Ids distincts des annonces visibles (pour le calcul du non-lu). */
const distinctVisibleIds = ({ campusId, role }) =>
  Announcement.find(visibleScope(campusId, role)).distinct('_id');

/** Ids des annonces visibles (lecture lean). */
const listVisibleIds = async ({ campusId, role }) => {
  const docs = await Announcement.find(visibleScope(campusId, role)).select('_id').lean();
  return docs.map((d) => d._id);
};

/** Nombre d'annonces lues parmi une liste d'ids. */
const countReadAmong = (userId, announcementIds) =>
  UserNotification.countDocuments({ userId, announcement: { $in: announcementIds } });

/** Checks that an announcement is visible to the user (existence). */
const findVisibleById = ({ id, campusId, role }) =>
  Announcement.findOne({ _id: id, ...visibleScope(campusId, role) }).lean();

/** Creates the read receipt if it does not exist (idempotent). */
const upsertReadReceipt = ({ userId, announcementId, campusId }) =>
  UserNotification.updateOne(
    { userId, announcement: announcementId },
    { $setOnInsert: { userId, announcement: announcementId, schoolCampus: campusId, readAt: new Date() } },
    { upsert: true },
  );

/**
 * Marque en lot toutes les annonces visibles non encore lues.
 * @returns {Promise<{visibleCount: number, marked: number}>}
 */
const markAllVisibleRead = async ({ userId, campusId, role }) => {
  const visibleIds = await listVisibleIds({ campusId, role });
  if (visibleIds.length === 0) return { visibleCount: 0, marked: 0 };

  const readIds = await listReadAmong(userId, visibleIds);
  const readSet = new Set(readIds.map((id) => id.toString()));

  const ops = visibleIds
    .filter((id) => !readSet.has(id.toString()))
    .map((id) => ({
      updateOne: {
        filter: { userId, announcement: id },
        update: { $setOnInsert: { userId, announcement: id, schoolCampus: campusId, readAt: new Date() } },
        upsert: true,
      },
    }));

  if (ops.length > 0) {
    await UserNotification.bulkWrite(ops, { ordered: false });
  }
  return { visibleCount: visibleIds.length, marked: ops.length };
};

// ── CRON ────────────────────────────────────────────────────────────────────

/** Archives expired published announcements. @returns {Promise<number>} modified */
const archiveExpired = async (now) => {
  const r = await Announcement.updateMany(
    { status: 'published', deletedAt: null, expiresAt: { $ne: null, $lte: now } },
    { $set: { status: 'archived', archivedAt: now } },
  );
  return r.modifiedCount || 0;
};

/** Unpins announcements whose pinnedUntil date has passed. @returns {Promise<number>} modified */
const unpinExpired = async (now) => {
  const r = await Announcement.updateMany(
    { pinned: true, deletedAt: null, pinnedUntil: { $ne: null, $lte: now } },
    { $set: { pinned: false, pinnedUntil: null } },
  );
  return r.modifiedCount || 0;
};

module.exports = {
  create,
  paginateForAdmin,
  findForAdmin,
  applyUpdate,
  listReadAmong,
  paginateVisible,
  distinctVisibleIds,
  listVisibleIds,
  countReadAmong,
  findVisibleById,
  upsertReadReceipt,
  markAllVisibleRead,
  archiveExpired,
  unpinExpired,
};
