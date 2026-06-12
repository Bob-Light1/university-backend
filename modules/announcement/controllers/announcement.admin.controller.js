'use strict';

const Announcement = require('../models/announcement.model');
const {
  sendSuccess,
  sendCreated,
  sendError,
  sendPaginated,
  sendNotFound,
} = require('../../../shared/utils/response-helpers');
const { isValidObjectId } = require('../../../shared/utils/validation-helpers');

const escapeRegex = (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ADMIN/DIRECTOR → no campus restriction; CAMPUS_MANAGER/STAFF → own campus only.
const buildCampusFilter = (user) => {
  if (['ADMIN', 'DIRECTOR'].includes(user.role)) return {};
  return { schoolCampus: user.campusId };
};

// ─── CREATE ──────────────────────────────────────────────────────────────────

const createAnnouncement = async (req, res) => {
  try {
    const { title, content, type, targetRoles, pinned, pinnedUntil, expiresAt } = req.body;

    if (!title || !content) {
      return sendError(res, 400, 'title and content are required.');
    }

    // ADMIN/DIRECTOR supply campusId in body; others use their own campus from JWT.
    const campusId = ['ADMIN', 'DIRECTOR'].includes(req.user.role)
      ? req.body.campusId
      : req.user.campusId;

    if (!campusId) {
      return sendError(res, 400, 'campusId is required.');
    }
    if (!isValidObjectId(campusId)) {
      return sendError(res, 400, 'Invalid campusId format.');
    }

    const announcement = await Announcement.create({
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

    const filter = { deletedAt: null, ...buildCampusFilter(req.user) };

    // ADMIN/DIRECTOR can narrow to a specific campus via query param.
    if (['ADMIN', 'DIRECTOR'].includes(req.user.role) && campusId) {
      filter.schoolCampus = campusId;
    }

    if (status)     filter.status     = status;
    if (type)       filter.type       = type;
    if (targetRole) filter.targetRoles = targetRole;
    if (pinned !== undefined) filter.pinned = pinned === 'true';

    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ title: rx }, { content: rx }];
    }

    const [data, total] = await Promise.all([
      Announcement.find(filter)
        .sort({ pinned: -1, createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
      Announcement.countDocuments(filter),
    ]);

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
    const filter = { _id: req.params.id, deletedAt: null, ...buildCampusFilter(req.user) };
    const announcement = await Announcement.findOne(filter).lean();
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
    const filter = { _id: req.params.id, deletedAt: null, ...buildCampusFilter(req.user) };
    const announcement = await Announcement.findOne(filter);
    if (!announcement) return sendNotFound(res, 'Announcement');

    if (announcement.status === 'published') {
      return sendError(res, 400, 'Published announcements cannot be edited. Archive it first.');
    }

    const allowed = ['title', 'content', 'type', 'targetRoles', 'pinned', 'pinnedUntil', 'expiresAt'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) announcement[key] = req.body[key];
    }

    await announcement.save();
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
    const filter = { _id: req.params.id, deletedAt: null, ...buildCampusFilter(req.user) };
    const announcement = await Announcement.findOne(filter);
    if (!announcement) return sendNotFound(res, 'Announcement');

    if (announcement.status === 'published') {
      return sendError(res, 400, 'Announcement is already published.');
    }

    if (announcement.expiresAt && announcement.expiresAt <= new Date()) {
      return sendError(res, 400, 'Announcement has already expired. Update or clear expiresAt before publishing.');
    }

    announcement.status      = 'published';
    announcement.publishedAt = new Date();
    announcement.archivedAt  = null;
    await announcement.save();

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
    const filter = { _id: req.params.id, deletedAt: null, ...buildCampusFilter(req.user) };
    const announcement = await Announcement.findOne(filter);
    if (!announcement) return sendNotFound(res, 'Announcement');

    if (announcement.status === 'archived') {
      return sendError(res, 400, 'Announcement is already archived.');
    }

    announcement.status     = 'archived';
    announcement.archivedAt = new Date();
    await announcement.save();

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
    const filter = { _id: req.params.id, deletedAt: null, ...buildCampusFilter(req.user) };
    const announcement = await Announcement.findOne(filter);
    if (!announcement) return sendNotFound(res, 'Announcement');

    announcement.pinned = !announcement.pinned;

    if (!announcement.pinned) {
      announcement.pinnedUntil = null;
    } else if (req.body.pinnedUntil !== undefined) {
      announcement.pinnedUntil = req.body.pinnedUntil;
    }

    await announcement.save();

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
    const filter = { _id: req.params.id, deletedAt: null, ...buildCampusFilter(req.user) };
    const announcement = await Announcement.findOne(filter);
    if (!announcement) return sendNotFound(res, 'Announcement');

    announcement.deletedAt = new Date();
    await announcement.save();

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
