'use strict';

/** @file announcement.admin.controller.js @description HTTP management handlers with transactional workflow delegation. */
const mutationService = require('../announcement.mutation.service');
const announcementRepo = require('../announcement.repository');
const {
  sendSuccess,
  sendCreated,
  sendError,
  sendPaginated,
  sendNotFound,
  sendForbidden,
  asyncHandler,
} = require('../../../shared/utils/response-helpers');
const { isValidObjectId } = require('../../../shared/utils/validation-helpers');

const isGlobalRole = (role) => ['ADMIN', 'DIRECTOR'].includes(role);

/**
 * Maps repository/Mongoose errors to the right HTTP response.
 *  - CAMPUS_ISOLATION → 403 (scoped role without a valid campusId)
 *  - ValidationError  → 400 (first schema message)
 *  - CastError        → 400 (malformed input, e.g. invalid date)
 *  - otherwise        → 500
 */
const handleError = (res, err, context, fallback) => {
  if (err.code === 'CAMPUS_ISOLATION') return sendForbidden(res, 'Campus access denied.');
  if (err.statusCode === 400) return sendError(res, 400, err.message);
  if (err.name === 'ValidationError') {
    return sendError(res, 400, Object.values(err.errors)[0]?.message || 'Validation failed.');
  }
  if (err.name === 'CastError') return sendError(res, 400, 'Invalid field value.');
  console.error(`${context} error:`, err);
  return sendError(res, 500, fallback);
};

const { futureDateError } = require('../announcement.validation');

// ─── CREATE ──────────────────────────────────────────────────────────────────

/** Handle createAnnouncement with the established response envelope. */
const createAnnouncement = asyncHandler(async (req, res) => {
  try {
    const { title, content, type, targetRoles, pinned, pinnedUntil, expiresAt } = req.body;

    if (!title || !content) {
      return sendError(res, 400, 'title and content are required.');
    }

    // ADMIN/DIRECTOR supply campusId in body; others use their own campus from JWT.
    const campusId = isGlobalRole(req.user.role) ? req.body.campusId : req.user.campusId;

    if (!campusId) {
      return sendError(res, 400, 'campusId is required.');
    }
    if (!isValidObjectId(campusId)) {
      return sendError(res, 400, 'Invalid campusId format.');
    }

    const expiryErr = futureDateError(expiresAt, 'expiry date');
    if (expiryErr) return sendError(res, 400, expiryErr);
    if (pinned) {
      const pinErr = futureDateError(pinnedUntil, 'auto-unpin date');
      if (pinErr) return sendError(res, 400, pinErr);
    }

    const announcement = await announcementRepo.create({
      schoolCampus: campusId,
      title,
      content,
      type:         type         || 'info',
      targetRoles:  targetRoles  || ['ALL'],
      pinned:       pinned       || false,
      pinnedUntil:  pinnedUntil  || null,
      expiresAt:    expiresAt    || null,
      createdBy: {
        userId: req.user.id,
        role:   req.user.role,
        name:   req.user.name || req.user.username || '',
      },
    });

    return sendCreated(res, 'Announcement created.', announcement);
  } catch (err) {
    return handleError(res, err, 'createAnnouncement', 'Failed to create announcement.');
  }
});

// ─── LIST ─────────────────────────────────────────────────────────────────────

/** Handle getAllAnnouncements with the established response envelope. */
const getAllAnnouncements = asyncHandler(async (req, res) => {
  try {
    const { page = 1, limit = 20, status, type, targetRole, pinned, search, campusId, deleted } = req.query;
    const safePage  = Math.max(1, Number(page)  || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const skip = (safePage - 1) * safeLimit;

    // The trash lists records an operator already removed from sight, and only ADMIN / DIRECTOR
    // may act on one (they are the roles the danger-zone registry declares for `announcement`).
    // Refuse the flag rather than quietly answering with the live list — that would read as
    // "the trash is empty".
    if (deleted === 'true' && !isGlobalRole(req.user.role)) {
      return sendForbidden(res, 'Only ADMIN and DIRECTOR may list deleted announcements.');
    }

    const { data, total } = await announcementRepo.paginateForAdmin({
      isGlobalRole:      isGlobalRole(req.user.role),
      campusId:          req.user.campusId,
      requestedCampusId: campusId, // narrow (ADMIN/DIRECTOR only — applied in the repo)
      // Trash view. It exists so a soft-deleted announcement can be reached at all: permanent
      // deletion refuses a live record, and the live list is the only one that existed.
      deleted:           deleted === 'true',
      status,
      type,
      targetRole,
      pinned: pinned !== undefined ? pinned === 'true' : undefined,
      search,
      skip,
      limit: safeLimit,
    });

    return sendPaginated(res, 200, 'Announcements retrieved.', data, {
      total,
      page:  safePage,
      limit: safeLimit,
    });
  } catch (err) {
    return handleError(res, err, 'getAllAnnouncements', 'Failed to fetch announcements.');
  }
});

// ─── GET ONE ─────────────────────────────────────────────────────────────────

/** Handle getOneAnnouncement with the established response envelope. */
const getOneAnnouncement = asyncHandler(async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid announcement ID format.');
    const announcement = await announcementRepo.findForAdmin({
      id: req.params.id, isGlobalRole: isGlobalRole(req.user.role), campusId: req.user.campusId,
    });
    if (!announcement) return sendNotFound(res, 'Announcement');

    return sendSuccess(res, 200, 'Announcement retrieved.', announcement);
  } catch (err) {
    return handleError(res, err, 'getOneAnnouncement', 'Failed to fetch announcement.');
  }
});

/** Apply an allowlisted update; service checks publication state in the transaction. */
const updateAnnouncement = asyncHandler(async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid announcement ID format.');
    const announcement = await mutationService.updateAnnouncement(req.params.id, req.user, req.body);
    if (!announcement) return sendNotFound(res, 'Announcement');
    return sendSuccess(res, 200, 'Announcement updated.', announcement);
  } catch (err) {
    return handleError(res, err, 'updateAnnouncement', 'Failed to update announcement.');
  }
});

/** Publish a draft or archived announcement with sticky audit eligibility. */
const publishAnnouncement = asyncHandler(async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid announcement ID format.');
    const announcement = await mutationService.publishAnnouncement(req.params.id, req.user);
    if (!announcement) return sendNotFound(res, 'Announcement');
    return sendSuccess(res, 200, 'Announcement published.', announcement);
  } catch (err) {
    return handleError(res, err, 'publishAnnouncement', 'Failed to publish announcement.');
  }
});

/** Archive within the authenticated campus and record an eligible lifecycle change. */
const archiveAnnouncement = asyncHandler(async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid announcement ID format.');
    const announcement = await mutationService.archiveAnnouncement(req.params.id, req.user);
    if (!announcement) return sendNotFound(res, 'Announcement');
    return sendSuccess(res, 200, 'Announcement archived.', announcement);
  } catch (err) {
    return handleError(res, err, 'archiveAnnouncement', 'Failed to archive announcement.');
  }
});

/** Toggle the current transactional pin state. */
const togglePin = asyncHandler(async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid announcement ID format.');
    const announcement = await mutationService.togglePin(req.params.id, req.user, req.body);
    if (!announcement) return sendNotFound(res, 'Announcement');
    return sendSuccess(res, 200, `Announcement ${announcement.pinned ? 'pinned' : 'unpinned'}.`, announcement);
  } catch (err) {
    return handleError(res, err, 'togglePin', 'Failed to update pin status.');
  }
});

/** Soft-delete with the model-derived marker and the same transaction as its audit event. */
const deleteAnnouncement = asyncHandler(async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid announcement ID format.');
    const announcement = await mutationService.deleteAnnouncement(req.params.id, req.user);
    if (!announcement) return sendNotFound(res, 'Announcement');
    return sendSuccess(res, 200, 'Announcement deleted.');
  } catch (err) {
    return handleError(res, err, 'deleteAnnouncement', 'Failed to delete announcement.');
  }
});

module.exports = {
  createAnnouncement,
  getAllAnnouncements,
  getOneAnnouncement,
  updateAnnouncement,
  publishAnnouncement,
  archiveAnnouncement,
  togglePin,
  deleteAnnouncement,
};
