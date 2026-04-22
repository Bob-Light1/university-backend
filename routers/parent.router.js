'use strict';

/**
 * @file parent.router.js
 * @description Express router for the Parent Management Module.
 *
 *  Mount point : app.use('/api/parents', parentRouter)
 *
 *  Route matrix (spec §6.1):
 *  ─────────────────────────────────────────────────────────────────────────────
 *  PUBLIC
 *    POST   /login                                    loginParent
 *
 *  PARENT self-service
 *    GET    /me                                       getMe
 *    PUT    /me/password                              updatePassword
 *    PUT    /me/profile                               updateProfile
 *    POST   /me/profile-image                         uploadProfileImage
 *    GET    /me/children                              getChildren
 *    GET    /me/children/:studentId/results           getChildResults
 *    GET    /me/children/:studentId/transcripts       getChildTranscripts
 *    POST   /me/children/:studentId/transcripts/:transcriptId/sign  signTranscript
 *    GET    /me/children/:studentId/schedule          getChildSchedule
 *    GET    /me/children/:studentId/attendance        getChildAttendance
 *    GET    /me/children/:studentId/teachers          getChildTeachers
 *    GET    /me/children/:studentId/comments          getChildComments
 *    GET    /me/dashboard                             getDashboard
 *
 *  ADMIN / DIRECTOR / CAMPUS_MANAGER management
 *    POST   /                                         createParent
 *    GET    /                                         getAllParents
 *    GET    /stats                                    getParentStats
 *    GET    /stats/campus/:campusId                   getCampusParentStats
 *    GET    /by-student/:studentId                    getParentsByStudent
 *    GET    /:id                                      getParentById
 *    PUT    /:id                                      updateParent
 *    PATCH  /:id/status                               updateParentStatus
 *    PATCH  /:id/children                             updateParentChildren
 *    PATCH  /:id/reset-password                       resetParentPassword
 *    DELETE /:id                                      deleteParent
 */

const express = require('express');

const router = express.Router();

// ── AUTH & RATE LIMITING ──────────────────────────────────────────────────────
const { authenticate, authorize } = require('../middleware/auth/auth');
const { loginLimiter, apiLimiter } = require('../middleware/rate-limiter/rate-limiter');

// ── FILE UPLOAD (multer) ──────────────────────────────────────────────────────
const {
  uploadProfileImage: multerProfileImage,
  handleMulterError,
} = require('../middleware/upload/upload');

// ── CONTROLLERS ───────────────────────────────────────────────────────────────
const {
  loginParent,
  getMe,
  updatePassword,
  updateProfile,
  uploadProfileImage,
} = require('../controllers/parent-controllers/parent.auth.controller');

const {
  createParent,
  getAllParents,
  getParentById,
  updateParent,
  updateParentStatus,
  updateParentChildren,
  resetParentPassword,
  deleteParent,
} = require('../controllers/parent-controllers/parent.crud.controller');

const {
  getChildren,
  getChildResults,
  getChildTranscripts,
  signTranscript,
  getChildSchedule,
  getChildAttendance,
  getChildTeachers,
  getChildComments,
  getDashboard,
} = require('../controllers/parent-controllers/parent.portal.controller');

const {
  getParentStats,
  getCampusParentStats,
  getParentsByStudent,
} = require('../controllers/parent-controllers/parent.analytics.controller');

// ── VALIDATION MIDDLEWARE ─────────────────────────────────────────────────────
const { validateCreateParent, validateUpdateParent, validateUpdateProfile } =
  require('../validations/createParentSchema');
const { validateChangePassword } =
  require('../validations/parentPasswordSchema');
const { validateParentChildren } =
  require('../validations/parentChildrenSchema');

// ── ROLE SHORTHANDS ───────────────────────────────────────────────────────────
const MANAGERS = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ════════════════════════════════════════════════════════════════════════════

/**
 * @route  POST /api/parents/login
 * @access Public
 */
router.post('/login', loginLimiter, loginParent);

// ════════════════════════════════════════════════════════════════════════════
// ALL ROUTES BELOW REQUIRE AUTHENTICATION
// ════════════════════════════════════════════════════════════════════════════
router.use(authenticate);

// ════════════════════════════════════════════════════════════════════════════
// ANALYTICS — must appear BEFORE /:id to avoid route shadowing
// ════════════════════════════════════════════════════════════════════════════

/**
 * @route  GET /api/parents/stats
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.get('/stats', authorize(MANAGERS), apiLimiter, getParentStats);

/**
 * @route  GET /api/parents/stats/campus/:campusId
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.get('/stats/campus/:campusId', authorize(MANAGERS), apiLimiter, getCampusParentStats);

/**
 * @route  GET /api/parents/by-student/:studentId
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.get('/by-student/:studentId', authorize(MANAGERS), apiLimiter, getParentsByStudent);

// ════════════════════════════════════════════════════════════════════════════
// PARENT SELF-SERVICE — /me routes
// ════════════════════════════════════════════════════════════════════════════

/**
 * @route  GET /api/parents/me
 * @access PARENT
 */
router.get('/me', authorize(['PARENT']), getMe);

/**
 * @route  PUT /api/parents/me/password
 * @access PARENT
 */
router.put(
  '/me/password',
  authorize(['PARENT']),
  validateChangePassword,
  updatePassword
);

/**
 * @route  PUT /api/parents/me/profile
 * @access PARENT
 */
router.put(
  '/me/profile',
  authorize(['PARENT']),
  validateUpdateProfile,
  updateProfile
);

/**
 * @route  POST /api/parents/me/profile-image
 * @access PARENT
 */
router.post('/me/profile-image', authorize(['PARENT']), uploadProfileImage);

/**
 * @route  GET /api/parents/me/dashboard
 * @access PARENT
 */
router.get('/me/dashboard', authorize(['PARENT']), apiLimiter, getDashboard);

/**
 * @route  GET /api/parents/me/children
 * @access PARENT
 */
router.get('/me/children', authorize(['PARENT']), getChildren);

/**
 * @route  GET /api/parents/me/children/:studentId/results
 * @access PARENT
 */
router.get(
  '/me/children/:studentId/results',
  authorize(['PARENT']),
  apiLimiter,
  getChildResults
);

/**
 * @route  GET /api/parents/me/children/:studentId/transcripts
 * @access PARENT
 */
router.get(
  '/me/children/:studentId/transcripts',
  authorize(['PARENT']),
  getChildTranscripts
);

/**
 * @route  POST /api/parents/me/children/:studentId/transcripts/:transcriptId/sign
 * @access PARENT
 */
router.post(
  '/me/children/:studentId/transcripts/:transcriptId/sign',
  authorize(['PARENT']),
  signTranscript
);

/**
 * @route  GET /api/parents/me/children/:studentId/schedule
 * @access PARENT
 */
router.get(
  '/me/children/:studentId/schedule',
  authorize(['PARENT']),
  apiLimiter,
  getChildSchedule
);

/**
 * @route  GET /api/parents/me/children/:studentId/attendance
 * @access PARENT
 */
router.get(
  '/me/children/:studentId/attendance',
  authorize(['PARENT']),
  apiLimiter,
  getChildAttendance
);

/**
 * @route  GET /api/parents/me/children/:studentId/teachers
 * @access PARENT
 */
router.get(
  '/me/children/:studentId/teachers',
  authorize(['PARENT']),
  getChildTeachers
);

/**
 * @route  GET /api/parents/me/children/:studentId/comments
 * @access PARENT
 */
router.get(
  '/me/children/:studentId/comments',
  authorize(['PARENT']),
  apiLimiter,
  getChildComments
);

// ════════════════════════════════════════════════════════════════════════════
// MANAGEMENT ROUTES (ADMIN / DIRECTOR / CAMPUS_MANAGER)
// ════════════════════════════════════════════════════════════════════════════

/**
 * @route  POST /api/parents
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.post(
  '/',
  authorize(MANAGERS),
  multerProfileImage,
  handleMulterError,
  validateCreateParent,
  createParent
);

/**
 * @route  GET /api/parents
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.get('/', authorize(MANAGERS), apiLimiter, getAllParents);

/**
 * @route  GET /api/parents/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.get('/:id', authorize(MANAGERS), getParentById);

/**
 * @route  PUT /api/parents/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.put(
  '/:id',
  authorize(MANAGERS),
  multerProfileImage,
  handleMulterError,
  validateUpdateParent,
  updateParent
);

/**
 * @route  PATCH /api/parents/:id/status
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.patch('/:id/status', authorize(MANAGERS), updateParentStatus);

/**
 * @route  PATCH /api/parents/:id/children
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.patch(
  '/:id/children',
  authorize(MANAGERS),
  validateParentChildren,
  updateParentChildren
);

/**
 * @route  PATCH /api/parents/:id/reset-password
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.patch('/:id/reset-password', authorize(MANAGERS), resetParentPassword);

/**
 * @route  DELETE /api/parents/:id
 * @desc   Soft-delete for all managers; hard-delete (?hard=true) for ADMIN only
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.delete('/:id', authorize(MANAGERS), deleteParent);

module.exports = router;
