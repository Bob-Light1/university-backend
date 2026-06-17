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
// USER INBOX  (/my/* avant /:id pour éviter la collision de paramètre)
// ========================================

/**
 * @route   GET /api/notifications/my
 * @desc    Boîte de réception in-app du destinataire courant
 * @access  Tous rôles authentifiés
 * @query   page, limit, unreadOnly=true
 */
router.get('/my', authorize(ALL_ROLES), apiLimiter, ctrl.getMyInbox);

/**
 * @route   GET /api/notifications/my/unread-count
 * @desc    Compteur de badge (notifications in-app non lues)
 * @access  Tous rôles authentifiés
 */
router.get('/my/unread-count', authorize(ALL_ROLES), apiLimiter, ctrl.getUnreadCount);

/**
 * @route   PATCH /api/notifications/my/read-all
 * @desc    Marquer toutes les notifications in-app comme lues
 * @access  Tous rôles authentifiés
 */
router.patch('/my/read-all', authorize(ALL_ROLES), apiLimiter, ctrl.markAllAsRead);

/**
 * @route   PATCH /api/notifications/:id/read
 * @desc    Marquer une notification in-app comme lue
 * @access  Tous rôles authentifiés (uniquement les siennes — anti-IDOR côté service)
 */
router.patch('/:id/read', authorize(ALL_ROLES), apiLimiter, ctrl.markAsRead);

// ========================================
// ADMIN — JOURNAL & RETRY
// ========================================

/**
 * @route   GET /api/notifications
 * @desc    Journal des envois (filtrable), isolé par campus
 * @access  ADMIN | DIRECTOR | CAMPUS_MANAGER
 * @query   page, limit, channel, status, recipientId, search, campusId (ADMIN/DIRECTOR only)
 */
router.get('/', authorize(MGMT_ROLES), apiLimiter, ctrl.getLog);

/**
 * @route   POST /api/notifications/:id/retry
 * @desc    Rejouer manuellement un envoi externe en échec
 * @access  ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.post('/:id/retry', authorize(MGMT_ROLES), apiLimiter, ctrl.retry);

module.exports = router;
