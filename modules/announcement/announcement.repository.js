'use strict';

/** @file announcement.repository.js @description Announcement persistence, campus scope and session-aware mutation primitives. */

const Announcement     = require('./models/announcement.model');
const UserNotification = require('./models/user-notification.model');
const { escapeRegex, isValidObjectId, buildCampusFilter } = require('../../shared/utils/validation-helpers');
const { notDeletedFilter, deletedOnlyFilter } = require('../../shared/utils/soft-delete');

/**
 * Not-deleted fragment for Announcement — derived, never hand-written.
 *
 * This model carries BOTH markers and they mean opposite things: `status: 'archived'` is the
 * EXPIRY state written by the nightly cron on a live announcement, while deletion is
 * `deletedAt`. Reading it the other way round hides live announcements and resurrects deleted
 * ones, so the convention is declared in STRATEGY_OVERRIDES rather than inferred here.
 */
const NOT_DELETED = notDeletedFilter(Announcement);
const { STATUS, OPERATION } = require('./announcement.constants');

/**
 * Deleted-only fragment — the exact complement of {@link NOT_DELETED}, derived from the same
 * declared convention. It backs the admin trash view, which is what makes an announcement
 * reachable for permanent deletion: the danger zone refuses a live record, so without a way to
 * list the soft-deleted ones the operator could never select one.
 */
const DELETED_ONLY = deletedOnlyFilter(Announcement);

// Internal scope filters.

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

// Admin scope: all (ADMIN/DIRECTOR) or own campus. Excludes deleted rows unless `deleted` is
// set, in which case it lists ONLY them — the trash view, which the controller restricts to
// global roles. Campus isolation is unchanged either way: a soft-deleted announcement belongs
// to the same tenant it always did.
const adminScope = ({ isGlobalRole, campusId, requestedCampusId, deleted = false }) => {
  const filter = { ...(deleted ? DELETED_ONLY : NOT_DELETED) };
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
  status:       STATUS.PUBLISHED,
  ...NOT_DELETED,
  $and: [
    { $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] },
    { $or: [{ targetRoles: role }, { targetRoles: 'ALL' }] },
  ],
});

// ── ADMIN ─────────────────────────────────────────────────────────────────────

/** Create the draft payload assembled by the management controller. */
const create = (data) => Announcement.create(data);

/**
 * Paginated management list, sorted by pin state then creation date.
 *
 * @param {boolean} [deleted=false] - List soft-deleted announcements instead of live ones.
 * @returns {Promise<{data: Object[], total: number}>}
 */
const paginateForAdmin = async ({
  isGlobalRole, campusId, requestedCampusId,
  status, type, targetRole, pinned, search, skip, limit, deleted = false,
}) => {
  const filter = adminScope({ isGlobalRole, campusId, requestedCampusId, deleted });
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

/** Run the owning service callback with automatic transaction retries and guaranteed cleanup. */
const withTransaction = async (callback) => {
  const session = await Announcement.db.startSession();
  try { return await session.withTransaction(() => callback(session)); }
  finally { await session.endSession(); }
};

/** Load a mutable document using authenticated campus scope within the transaction. */
const loadForMutation = ({ id, user }, session) => {
  let campus;
  try { campus = buildCampusFilter(user); }
  catch (error) { error.code = 'CAMPUS_ISOLATION'; throw error; }
  return Announcement.findOne({ _id: id, ...campus, ...NOT_DELETED }).session(session);
};

/** Save through setters/hooks, then re-read the actual persisted state for projection. */
const saveMutation = async (doc, session) => {
  await doc.save({ session });
  return Announcement.findById(doc._id).session(session).lean();
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
 * Paginated visible announcements, sorted by pin state then publication date.
 * `excludeIds` supports the unread-only filter.
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

/** Distinct visible announcement IDs for unread counts. */
const distinctVisibleIds = ({ campusId, role }) =>
  Announcement.find(visibleScope(campusId, role)).distinct('_id');

/** Visible announcement IDs without hydration. */
const listVisibleIds = async ({ campusId, role }) => {
  const docs = await Announcement.find(visibleScope(campusId, role)).select('_id').lean();
  return docs.map((d) => d._id);
};

/** Count receipts among a bounded list of announcements. */
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
 * Mark every visible unread announcement as read.
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

/** Build the exact due predicate used both for discovery and transactional recheck. */
const dueFilter = (operation, now) => {
  if (operation === OPERATION.EXPIRE) return {
    ...NOT_DELETED, status: STATUS.PUBLISHED, expiresAt: { $ne: null, $lte: now },
  };
  if (operation === OPERATION.UNPIN) return {
    ...NOT_DELETED, pinned: true, pinnedUntil: { $ne: null, $lte: now },
  };
  throw new Error('Unknown announcement sweep operation.');
};

/** Bounded keyset discovery; no whole-collection materialization or multi-row unaudited update. */
const listDue = (operation, now, { afterId, limit }) => Announcement.find({
  ...dueFilter(operation, now), ...(afterId ? { _id: { $gt: afterId } } : {}),
}).sort({ _id: 1 }).limit(limit).select('_id').lean();

/** Recheck the current due state and campus from storage, never from job discovery metadata. */
const loadDue = (id, operation, now, session) =>
  Announcement.findOne({ _id: id, ...dueFilter(operation, now) }).session(session);

module.exports = {
  create,
  paginateForAdmin,
  findForAdmin,
  withTransaction,
  loadForMutation,
  saveMutation,
  listReadAmong,
  paginateVisible,
  distinctVisibleIds,
  listVisibleIds,
  countReadAmong,
  findVisibleById,
  upsertReadReceipt,
  markAllVisibleRead,
  listDue,
  loadDue,
};
