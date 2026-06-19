'use strict';

/**
 * @file notification.controller.js — HTTP layer of the notifications core.
 *
 * Two surfaces:
 *   - current recipient's in-app inbox (req.user);
 *   - admin log (read + manual retry of an external delivery).
 *
 * No Mongoose query here — everything goes through notification.service.
 */

const service = require('../notification.service');
const { buildCampusFilter } = require('../../../shared/utils/validation-helpers');

// ── Inbox (all authenticated roles) ──────────────────────────────

const getMyInbox = async (req, res) => {
  try {
    const page  = parseInt(req.query.page, 10)  || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const unreadOnly = req.query.unreadOnly === 'true';
    const result = await service.getInbox({ recipientId: req.user.id, unreadOnly, page, limit });
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const getUnreadCount = async (req, res) => {
  try {
    const count = await service.getUnreadCount(req.user.id);
    return res.status(200).json({ success: true, count });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const markAsRead = async (req, res) => {
  try {
    const ok = await service.markRead(req.params.id, req.user.id);
    if (!ok) return res.status(404).json({ success: false, message: 'Notification not found or already read' });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const markAllAsRead = async (req, res) => {
  try {
    const modified = await service.markAllRead(req.user.id);
    return res.status(200).json({ success: true, modified });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── Admin log ─────────────────────────────────────────────────────────────

const getLog = async (req, res) => {
  try {
    const campusFilter = buildCampusFilter(req.user, req.query.campusId);
    const page  = parseInt(req.query.page, 10)  || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const { channel, status, recipientId, search } = req.query;
    const { data, total } = await service.getLog({
      campusFilter, channel, status, recipientId, search, page, limit,
    });
    return res.status(200).json({ success: true, data, total, page, limit });
  } catch (err) {
    // buildCampusFilter throws on an isolation breach → 403
    if (/Campus isolation breach/.test(err.message)) {
      return res.status(403).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

const retry = async (req, res) => {
  try {
    const status = await service.retryOne(req.params.id);
    return res.status(200).json({ success: true, status });
  } catch (err) {
    if (/not found/i.test(err.message)) {
      return res.status(404).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  getMyInbox,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  getLog,
  retry,
};
