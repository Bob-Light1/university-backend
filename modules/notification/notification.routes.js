'use strict';

const express = require('express');
const router  = express.Router();

const ctrl = require('./controllers/notification.controller');
const whatsapp = require('./controllers/whatsapp.controller');
const { authenticate, authorize } = require('../../shared/middleware/auth');
const { apiLimiter } = require('../../shared/middleware/rate-limiter');

const ALL_ROLES = [
  'ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER',
  'TEACHER', 'STUDENT', 'PARENT', 'PARTNER', 'STAFF', 'MENTOR',
];
const MGMT_ROLES = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];

/** @route GET /api/notifications/whatsapp/webhook @desc Meta verification handshake @access Public, verify-token protected */
router.get('/whatsapp/webhook', apiLimiter, whatsapp.verify);
/** @route POST /api/notifications/whatsapp/webhook @desc Signed delivery receipts @access Public, HMAC protected */
router.post('/whatsapp/webhook', apiLimiter, whatsapp.receive);

router.use(authenticate);

/** @route GET /api/notifications/my/whatsapp-consent @desc Own explicit consent @access All authenticated roles */
router.get('/my/whatsapp-consent', authorize(ALL_ROLES), apiLimiter, whatsapp.getConsent);
/** @route PUT /api/notifications/my/whatsapp-consent @desc Own consent grant or withdrawal @access All authenticated roles */
router.put('/my/whatsapp-consent', authorize(ALL_ROLES), apiLimiter, whatsapp.updateConsent);
/** @route GET /api/notifications/whatsapp-usage @desc Campus monthly cost allowance @access Management */
router.get('/whatsapp-usage', authorize(MGMT_ROLES), apiLimiter, whatsapp.usage);

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
