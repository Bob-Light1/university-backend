'use strict';

const announcementRepo = require('../announcement.repository');
const {
  sendSuccess,
  sendCreated,
  sendError,
  sendPaginated,
  sendNotFound,
} = require('../../../shared/utils/response-helpers');
const { isValidObjectId } = require('../../../shared/utils/validation-helpers');

const isGlobalRole = (role) => ['ADMIN', 'DIRECTOR'].includes(role);

// ─── CREATE ──────────────────────────────────────────────────────────────────

const createAnnouncement = async (req, res) => {
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
    if (err.name === 'ValidationError') {
      const msg = Object.values(err.errors)[0]?.message || 'Validation failed.';
      return sendError(res, 400, msg);
    }
    console.error('createAnnouncement error:', err);
    return sendError(res, 500, 'Failed to create announcement.');
  }
};

// ─── LIST ─────────────────────────────────────────────────────────────────────

const getAllAnnouncements = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, type, targetRole, pinned, search, campusId } = req.query;
    const safePage  = Math.max(1, Number(page)  || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const skip = (safePage - 1) * safeLimit;

    const { data, total } = await announcementRepo.paginateForAdmin({
      isGlobalRole:      isGlobalRole(req.user.role),
      campusId:          req.user.campusId,
      requestedCampusId: campusId, // narrow (ADMIN/DIRECTOR only — appliqué dans le repo)
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
    console.error('getAllAnnouncements error:', err);
    return sendError(res, 500, 'Failed to fetch announcements.');
  }
};

// ─── GET ONE ─────────────────────────────────────────────────────────────────

const getOneAnnouncement = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid announcement ID format.');
    const announcement = await announcementRepo.findForAdmin({
      id: req.params.id, isGlobalRole: isGlobalRole(req.user.role), campusId: req.user.campusId,
    });
    if (!announcement) return sendNotFound(res, 'Announcement');

    return sendSuccess(res, 200, 'Announcement retrieved.', announcement);
  } catch (err) {
    console.error('getOneAnnouncement error:', err);
    return sendError(res, 500, 'Failed to fetch announcement.');
  }
};

// ─── UPDATE ───────────────────────────────────────────────────────────────────

const updateAnnouncement = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid announcement ID format.');
    const scope = { id: req.params.id, isGlobalRole: isGlobalRole(req.user.role), campusId: req.user.campusId };

    const current = await announcementRepo.findForAdmin(scope);
    if (!current) return sendNotFound(res, 'Announcement');

    if (current.status === 'published') {
      return sendError(res, 400, 'Published announcements cannot be edited. Archive it first.');
    }

    const allowed = ['title', 'content', 'type', 'targetRoles', 'pinned', 'pinnedUntil', 'expiresAt'];
    const fields = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) fields[key] = req.body[key];
    }

    const announcement = await announcementRepo.applyUpdate(scope, fields);
    if (!announcement) return sendNotFound(res, 'Announcement');
    return sendSuccess(res, 200, 'Announcement updated.', announcement);
  } catch (err) {
    if (err.name === 'ValidationError') {
      const msg = Object.values(err.errors)[0]?.message || 'Validation failed.';
      return sendError(res, 400, msg);
    }
    console.error('updateAnnouncement error:', err);
    return sendError(res, 500, 'Failed to update announcement.');
  }
};

// ─── PUBLISH ──────────────────────────────────────────────────────────────────

const publishAnnouncement = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid announcement ID format.');
    const scope = { id: req.params.id, isGlobalRole: isGlobalRole(req.user.role), campusId: req.user.campusId };

    const current = await announcementRepo.findForAdmin(scope);
    if (!current) return sendNotFound(res, 'Announcement');

    if (current.status === 'published') {
      return sendError(res, 400, 'Announcement is already published.');
    }
    if (current.expiresAt && new Date(current.expiresAt) <= new Date()) {
      return sendError(res, 400, 'Announcement has already expired. Update or clear expiresAt before publishing.');
    }

    const announcement = await announcementRepo.applyUpdate(scope, {
      status: 'published', publishedAt: new Date(), archivedAt: null,
    });
    if (!announcement) return sendNotFound(res, 'Announcement');
    return sendSuccess(res, 200, 'Announcement published.', announcement);
  } catch (err) {
    console.error('publishAnnouncement error:', err);
    return sendError(res, 500, 'Failed to publish announcement.');
  }
};

// ─── ARCHIVE ──────────────────────────────────────────────────────────────────

const archiveAnnouncement = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid announcement ID format.');
    const scope = { id: req.params.id, isGlobalRole: isGlobalRole(req.user.role), campusId: req.user.campusId };

    const current = await announcementRepo.findForAdmin(scope);
    if (!current) return sendNotFound(res, 'Announcement');

    if (current.status === 'archived') {
      return sendError(res, 400, 'Announcement is already archived.');
    }

    const announcement = await announcementRepo.applyUpdate(scope, {
      status: 'archived', archivedAt: new Date(),
    });
    if (!announcement) return sendNotFound(res, 'Announcement');
    return sendSuccess(res, 200, 'Announcement archived.', announcement);
  } catch (err) {
    console.error('archiveAnnouncement error:', err);
    return sendError(res, 500, 'Failed to archive announcement.');
  }
};

// ─── PIN TOGGLE ───────────────────────────────────────────────────────────────

const togglePin = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid announcement ID format.');
    const scope = { id: req.params.id, isGlobalRole: isGlobalRole(req.user.role), campusId: req.user.campusId };

    const current = await announcementRepo.findForAdmin(scope);
    if (!current) return sendNotFound(res, 'Announcement');

    const nextPinned = !current.pinned;
    const fields = { pinned: nextPinned };
    if (!nextPinned) {
      fields.pinnedUntil = null;
    } else if (req.body.pinnedUntil !== undefined) {
      fields.pinnedUntil = req.body.pinnedUntil;
    }

    const announcement = await announcementRepo.applyUpdate(scope, fields);
    if (!announcement) return sendNotFound(res, 'Announcement');

    const action = announcement.pinned ? 'pinned' : 'unpinned';
    return sendSuccess(res, 200, `Announcement ${action}.`, announcement);
  } catch (err) {
    console.error('togglePin error:', err);
    return sendError(res, 500, 'Failed to update pin status.');
  }
};

// ─── SOFT DELETE ──────────────────────────────────────────────────────────────

const deleteAnnouncement = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid announcement ID format.');
    const scope = { id: req.params.id, isGlobalRole: isGlobalRole(req.user.role), campusId: req.user.campusId };

    const announcement = await announcementRepo.applyUpdate(scope, { deletedAt: new Date() });
    if (!announcement) return sendNotFound(res, 'Announcement');

    return sendSuccess(res, 200, 'Announcement deleted.');
  } catch (err) {
    console.error('deleteAnnouncement error:', err);
    return sendError(res, 500, 'Failed to delete announcement.');
  }
};

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
