'use strict';

const express = require('express');
const router  = express.Router();

const ctrl = require('./controllers/notification.controller');
const { authenticate, authorize } = require('../../shared/middleware/auth');
const { apiLimiter } = require('../../shared/middleware/rate-limiter');

const ALL_ROLES = [
  'ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER',
  'TEACHER', 'STUDENT', 'PARENT', 'PARTNER', 'STAFF', 'MENTOR',
];
const MGMT_ROLES = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];

router.use(authenticate);

// ========================================
// USER INBOX  (/my/* before /:id to avoid the parameter collision)
// ========================================

/**
 * @route   GET /api/notifications/my
 * @desc    Current recipient's in-app inbox
 * @access  All authenticated roles
 * @query   page, limit, unreadOnly=true
 */
router.get('/my', authorize(ALL_ROLES), apiLimiter, ctrl.getMyInbox);

/**
 * @route   GET /api/notifications/my/unread-count
 * @desc    Badge counter (unread in-app notifications)
 * @access  All authenticated roles
 */
router.get('/my/unread-count', authorize(ALL_ROLES), apiLimiter, ctrl.getUnreadCount);

/**
 * @route   PATCH /api/notifications/my/read-all
 * @desc    Mark all in-app notifications as read
 * @access  All authenticated roles
 */
router.patch('/my/read-all', authorize(ALL_ROLES), apiLimiter, ctrl.markAllAsRead);

/**
 * @route   PATCH /api/notifications/:id/read
 * @desc    Mark an in-app notification as read
 * @access  All authenticated roles (only their own — anti-IDOR on the service side)
 */
router.patch('/:id/read', authorize(ALL_ROLES), apiLimiter, ctrl.markAsRead);

// ========================================
// ADMIN — JOURNAL & RETRY
// ========================================

/**
 * @route   GET /api/notifications
 * @desc    Delivery log (filterable), isolated by campus
 * @access  ADMIN | DIRECTOR | CAMPUS_MANAGER
 * @query   page, limit, channel, status, recipientId, search, campusId (ADMIN/DIRECTOR only)
 */
router.get('/', authorize(MGMT_ROLES), apiLimiter, ctrl.getLog);

/**
 * @route   POST /api/notifications/:id/retry
 * @desc    Manually replay a failed external delivery
 * @access  ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.post('/:id/retry', authorize(MGMT_ROLES), apiLimiter, ctrl.retry);

module.exports = router;
