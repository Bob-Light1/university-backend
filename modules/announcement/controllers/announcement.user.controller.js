'use strict';

const announcementRepo = require('../announcement.repository');
const {
  sendSuccess,
  sendError,
  sendPaginated,
  sendNotFound,
} = require('../../../shared/utils/response-helpers');
const { isValidObjectId } = require('../../../shared/utils/validation-helpers');

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

    // Read receipts: needed for the "unread" filter AND the isRead flag.
    const readIds = await announcementRepo.listReadAnnouncementIds(userId, campusId);
    const readSet = new Set(readIds.map((id) => id.toString()));

    const { data: announcements, total } = await announcementRepo.paginateVisible({
      campusId,
      role,
      type,
      excludeIds: unreadOnly === 'true' ? readIds : undefined,
      skip,
      limit: safeLimit,
    });

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

    const visibleIds = await announcementRepo.distinctVisibleIds({ campusId, role });
    const readCount  = await announcementRepo.countReadAmong(userId, visibleIds);

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

    // Verify that the announcement is visible to this user.
    const announcement = await announcementRepo.findVisibleById({ id: announcementId, campusId, role });
    if (!announcement) return sendNotFound(res, 'Announcement');

    await announcementRepo.upsertReadReceipt({ userId, announcementId, campusId });

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

    const { visibleCount, marked } = await announcementRepo.markAllVisibleRead({ userId, campusId, role });

    if (visibleCount === 0) {
      return sendSuccess(res, 200, 'No announcements to mark as read.', { marked: 0 });
    }

    return sendSuccess(res, 200, 'All announcements marked as read.', { marked });
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
