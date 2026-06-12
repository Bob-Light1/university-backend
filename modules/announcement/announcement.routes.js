'use strict';

const express = require('express');
const router  = express.Router();

const adminCtrl = require('./controllers/announcement.admin.controller');
const userCtrl  = require('./controllers/announcement.user.controller');
const { authenticate, authorize, requirePermission } = require('../../shared/middleware/auth');
const { apiLimiter } = require('../../shared/middleware/rate-limiter');

const MGMT_ROLES = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];
const ALL_ROLES  = [
  'ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER',
  'TEACHER', 'STUDENT', 'PARENT', 'PARTNER', 'STAFF', 'MENTOR',
];

/**
 * Allows MGMT_ROLES or STAFF members with the 'announcements' permission.
 * Must be used after authenticate.
 */
const canManage = (req, res, next) => {
  const { role, permissions } = req.user || {};
  if (MGMT_ROLES.includes(role)) return next();
  if (role === 'STAFF' && Array.isArray(permissions) && permissions.includes('announcements')) {
    return next();
  }
  return res.status(403).json({ success: false, message: 'Access denied. Insufficient permissions.' });
};

router.use(authenticate);

// ========================================
// USER INBOX  (all /my/* before /:id to avoid param collision)
// ========================================

/**
 * @route   GET /api/announcements/my
 * @desc    Inbox: published announcements for the current user's role & campus
 * @access  All authenticated roles
 * @query   page, limit, type, unreadOnly=true
 */
router.get('/my', authorize(ALL_ROLES), apiLimiter, userCtrl.getMyAnnouncements);

/**
 * @route   GET /api/announcements/my/unread-count
 * @desc    Badge count: how many announcements haven't been read yet
 * @access  All authenticated roles
 */
router.get('/my/unread-count', authorize(ALL_ROLES), userCtrl.getUnreadCount);

/**
 * @route   PATCH /api/announcements/my/read-all
 * @desc    Mark all visible announcements as read in one shot
 * @access  All authenticated roles
 */
router.patch('/my/read-all', authorize(ALL_ROLES), userCtrl.markAllAsRead);

/**
 * @route   PATCH /api/announcements/:id/read
 * @desc    Mark a single announcement as read
 * @access  All authenticated roles
 */
router.patch('/:id/read', authorize(ALL_ROLES), userCtrl.markAsRead);

// ========================================
// ADMIN MANAGEMENT
// ========================================

/**
 * @route   POST /api/announcements
 * @desc    Create a new announcement (draft)
 * @access  ADMIN | DIRECTOR | CAMPUS_MANAGER | STAFF[announcements]
 * @body    { title, content, type?, targetRoles?, pinned?, pinnedUntil?, expiresAt?, campusId? }
 */
router.post('/', canManage, apiLimiter, adminCtrl.createAnnouncement);

/**
 * @route   GET /api/announcements
 * @desc    List all announcements for the campus (filterable)
 * @access  ADMIN | DIRECTOR | CAMPUS_MANAGER | STAFF[announcements]
 * @query   page, limit, status, type, targetRole, pinned, search, campusId (ADMIN only)
 */
router.get('/', canManage, apiLimiter, adminCtrl.getAllAnnouncements);

/**
 * @route   GET /api/announcements/:id
 * @desc    Get full details of one announcement
 * @access  ADMIN | DIRECTOR | CAMPUS_MANAGER | STAFF[announcements]
 */
router.get('/:id', canManage, apiLimiter, adminCtrl.getOneAnnouncement);

/**
 * @route   PUT /api/announcements/:id
 * @desc    Update a draft announcement (published → archive first)
 * @access  ADMIN | DIRECTOR | CAMPUS_MANAGER | STAFF[announcements]
 */
router.put('/:id', canManage, apiLimiter, adminCtrl.updateAnnouncement);

/**
 * @route   PATCH /api/announcements/:id/publish
 * @desc    Publish a draft announcement (makes it visible to targeted users)
 * @access  ADMIN | DIRECTOR | CAMPUS_MANAGER | STAFF[announcements]
 */
router.patch('/:id/publish', canManage, apiLimiter, adminCtrl.publishAnnouncement);

/**
 * @route   PATCH /api/announcements/:id/archive
 * @desc    Archive an announcement (remove from user inboxes)
 * @access  ADMIN | DIRECTOR | CAMPUS_MANAGER | STAFF[announcements]
 */
router.patch('/:id/archive', canManage, apiLimiter, adminCtrl.archiveAnnouncement);

/**
 * @route   PATCH /api/announcements/:id/pin
 * @desc    Toggle pin status. Body: { pinnedUntil? } to set an auto-unpin date.
 * @access  ADMIN | DIRECTOR | CAMPUS_MANAGER | STAFF[announcements]
 */
router.patch('/:id/pin', canManage, apiLimiter, adminCtrl.togglePin);

/**
 * @route   DELETE /api/announcements/:id
 * @desc    Soft-delete an announcement (irreversible for users)
 * @access  ADMIN | DIRECTOR | CAMPUS_MANAGER | STAFF[announcements]
 */
router.delete('/:id', canManage, apiLimiter, adminCtrl.deleteAnnouncement);

module.exports = router;
