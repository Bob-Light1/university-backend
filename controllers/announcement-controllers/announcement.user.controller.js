'use strict';

const Announcement     = require('../../models/announcement.model');
const UserNotification = require('../../models/user-notification.model');
const {
  sendSuccess,
  sendError,
  sendPaginated,
  sendNotFound,
} = require('../../utils/response-helpers');
const { isValidObjectId } = require('../../utils/validation-helpers');

// Builds the MongoDB filter for announcements visible to the current user.
const buildVisibleFilter = (campusId, role) => {
  const now = new Date();
  return {
    schoolCampus: campusId,
    status: 'published',
    deletedAt: null,
    $and: [
      { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
      { $or: [{ targetRoles: role }, { targetRoles: 'ALL' }] },
    ],
  };
};

// ─── GET MY ANNOUNCEMENTS ────────────────────────────────────────────────────

const getMyAnnouncements = async (req, res) => {
  try {
    const { id: userId, role, campusId } = req.user;

    if (!campusId) {
      return sendPaginated(res, 200, 'No campus assigned.', [], {
        total: 0, page: 1, limit: 20,
      });
    }

    const { page = 1, limit = 20, type, unreadOnly } = req.query;
    const safePage  = Math.max(1, Number(page)  || 1);
    const safeLimit = Math.min(50, Math.max(1, Number(limit) || 20));
    const skip = (safePage - 1) * safeLimit;

    const filter = buildVisibleFilter(campusId, role);
    if (type) filter.type = type;

    // Pre-fetch read receipts: needed for both the unreadOnly DB filter and the isRead flag.
    // Must run before the paginated query so the $nin constraint is applied server-side,
    // keeping pagination counts accurate.
    const receipts = await UserNotification.find({ userId, schoolCampus: campusId })
      .select('announcement').lean();
    const readSet = new Set(receipts.map((r) => r.announcement.toString()));

    if (unreadOnly === 'true') {
      filter._id = { $nin: receipts.map((r) => r.announcement) };
    }

    const [announcements, total] = await Promise.all([
      Announcement.find(filter)
        .sort({ pinned: -1, publishedAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
      Announcement.countDocuments(filter),
    ]);

    const data = announcements.map((a) => ({
      ...a,
      isRead: readSet.has(a._id.toString()),
    }));

    return sendPaginated(res, 200, 'Announcements retrieved.', data, {
      total,
      page:  safePage,
      limit: safeLimit,
    });
  } catch (err) {
    console.error('getMyAnnouncements error:', err);
    return sendError(res, 500, 'Failed to fetch announcements.');
  }
};

// ─── UNREAD COUNT ─────────────────────────────────────────────────────────────

const getUnreadCount = async (req, res) => {
  try {
    const { id: userId, role, campusId } = req.user;

    if (!campusId) return sendSuccess(res, 200, 'Unread count.', { count: 0 });

    const filter = buildVisibleFilter(campusId, role);

    // Get IDs of all visible announcements, then count how many are already read.
    const visibleIds = await Announcement.find(filter).distinct('_id');

    const readCount = await UserNotification.countDocuments({
      userId,
      announcement: { $in: visibleIds },
    });

    return sendSuccess(res, 200, 'Unread count.', {
      count: Math.max(0, visibleIds.length - readCount),
    });
  } catch (err) {
    console.error('getUnreadCount error:', err);
    return sendError(res, 500, 'Failed to get unread count.');
  }
};

// ─── MARK ONE AS READ ─────────────────────────────────────────────────────────

const markAsRead = async (req, res) => {
  try {
    const { id: userId, role, campusId } = req.user;
    const { id: announcementId } = req.params;

    if (!isValidObjectId(announcementId)) return sendError(res, 400, 'Invalid announcement ID format.');
    if (!campusId) return sendError(res, 400, 'No campus assigned.');

    // Verify the announcement is actually visible to this user.
    const announcement = await Announcement.findOne({
      _id: announcementId,
      ...buildVisibleFilter(campusId, role),
    });
    if (!announcement) return sendNotFound(res, 'Announcement');

    // Upsert: create receipt only if it doesn't already exist.
    await UserNotification.updateOne(
      { userId, announcement: announcementId },
      {
        $setOnInsert: {
          userId,
          announcement: announcementId,
          schoolCampus: campusId,
          readAt: new Date(),
        },
      },
      { upsert: true }
    );

    return sendSuccess(res, 200, 'Marked as read.');
  } catch (err) {
    console.error('markAsRead error:', err);
    return sendError(res, 500, 'Failed to mark as read.');
  }
};

// ─── MARK ALL AS READ ─────────────────────────────────────────────────────────

const markAllAsRead = async (req, res) => {
  try {
    const { id: userId, role, campusId } = req.user;

    if (!campusId) return sendError(res, 400, 'No campus assigned.');

    const filter = buildVisibleFilter(campusId, role);
    const announcements = await Announcement.find(filter).select('_id').lean();

    if (announcements.length === 0) {
      return sendSuccess(res, 200, 'No announcements to mark as read.', { marked: 0 });
    }

    // Exclude those already read.
    const alreadyRead = await UserNotification.find({ userId, schoolCampus: campusId })
      .select('announcement')
      .lean();
    const readSet = new Set(alreadyRead.map((r) => r.announcement.toString()));

    const toInsert = announcements
      .filter((a) => !readSet.has(a._id.toString()))
      .map((a) => ({
        updateOne: {
          filter: { userId, announcement: a._id },
          update: {
            $setOnInsert: {
              userId,
              announcement: a._id,
              schoolCampus: campusId,
              readAt: new Date(),
            },
          },
          upsert: true,
        },
      }));

    if (toInsert.length > 0) {
      await UserNotification.bulkWrite(toInsert, { ordered: false });
    }

    return sendSuccess(res, 200, 'All announcements marked as read.', {
      marked: toInsert.length,
    });
  } catch (err) {
    console.error('markAllAsRead error:', err);
    return sendError(res, 500, 'Failed to mark all as read.');
  }
};

module.exports = {
  getMyAnnouncements,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
};
