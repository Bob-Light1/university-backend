'use strict';

/**
 * @file notification.controller.js — HTTP layer of the notifications core.
 *
 * Two surfaces:
 *   - current recipient's in-app inbox (req.user);
 *   - admin log (read + manual retry of an external delivery).
 *
 * No Mongoose query here — everything goes through notification.service.
 * Responses go exclusively through the shared response helpers (§4).
 */

const service = require('../notification.service');
const { buildCampusFilter, isValidObjectId } = require('../../../shared/utils/validation-helpers');
const {
  asyncHandler,
  sendSuccess,
  sendPaginated,
  sendNotFound,
  sendForbidden,
} = require('../../../shared/utils/response-helpers');

// Clamp pagination input to safe bounds (defence against abusive limits).
const parsePage  = (raw) => Math.max(parseInt(raw, 10) || 1, 1);
const parseLimit = (raw) => Math.min(Math.max(parseInt(raw, 10) || 20, 1), 100);

// ── Inbox (all authenticated roles) ──────────────────────────────

const getMyInbox = asyncHandler(async (req, res) => {
  const page  = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit);
  const unreadOnly = req.query.unreadOnly === 'true';
  const { data, total } = await service.getInbox({ recipientId: req.user.id, unreadOnly, page, limit });
  return sendPaginated(res, 200, 'Inbox retrieved', data, { total, page, limit });
});

const getUnreadCount = asyncHandler(async (req, res) => {
  const count = await service.getUnreadCount(req.user.id);
  return sendSuccess(res, 200, 'Unread count retrieved', { count });
});

const markAsRead = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return sendNotFound(res, 'Notification');
  const ok = await service.markRead(req.params.id, req.user.id);
  if (!ok) return sendNotFound(res, 'Notification');
  return sendSuccess(res, 200, 'Notification marked as read');
});

const markAllAsRead = asyncHandler(async (req, res) => {
  const modified = await service.markAllRead(req.user.id);
  return sendSuccess(res, 200, 'Notifications marked as read', { modified });
});

// ── Admin log ─────────────────────────────────────────────────────────────

const getLog = asyncHandler(async (req, res) => {
  let campusFilter;
  try {
    // buildCampusFilter throws synchronously on an isolation breach → 403.
    campusFilter = buildCampusFilter(req.user, req.query.campusId);
  } catch (err) {
    return sendForbidden(res, err.message);
  }

  const page  = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit);
  const { channel, status, recipientId, search } = req.query;
  const { data, total } = await service.getLog({
    campusFilter, channel, status, recipientId, search, page, limit,
  });
  return sendPaginated(res, 200, 'Notification log retrieved', data, { total, page, limit });
});

const retry = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return sendNotFound(res, 'Notification');
  try {
    const status = await service.retryOne(req.params.id);
    return sendSuccess(res, 200, 'Notification delivery replayed', { status });
  } catch (err) {
    if (/not found/i.test(err.message)) return sendNotFound(res, 'Notification');
    throw err; // unexpected → global error handler (no raw leak to the client)
  }
});

module.exports = {
  getMyInbox,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  getLog,
  retry,
};
