'use strict';

const express = require('express');
const router  = express.Router();

const mentorController          = require('../controllers/mentor-controllers/mentor.controller');
const mentorProfileController   = require('../controllers/mentor-controllers/mentor.profile.controller');
const mentorReadonlyController  = require('../controllers/mentor-controllers/mentor.readonly.controller');
const { authenticate, authorize, isOwnerOrRole } = require('../middleware/auth/auth');
const { loginLimiter } = require('../middleware/rate-limiter/rate-limiter');

const MGMT_ROLES = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];

// ========================================
// PUBLIC ROUTES
// ========================================

/**
 * @route  POST /api/mentors/login
 * @access Public
 */
router.post('/login', loginLimiter, mentorController.loginMentor);

// ========================================
// PROTECTED ROUTES
// ========================================
router.use(authenticate);

// ========================================
// MENTOR SELF-SERVICE  (/me/* before /:id)
// ========================================

router.get(
  '/me',
  authorize(['MENTOR']),
  mentorProfileController.getMe
);

router.patch(
  '/me/profile',
  authorize(['MENTOR']),
  mentorProfileController.updateProfile
);

router.patch(
  '/me/password',
  authorize(['MENTOR']),
  mentorProfileController.changePassword
);

router.patch(
  '/me/profile-image',
  authorize(['MENTOR']),
  mentorProfileController.uploadProfileImage
);

router.patch(
  '/me/notifications',
  authorize(['MENTOR']),
  mentorProfileController.updateNotifications
);

router.get(
  '/me/upload-signature',
  authorize(['MENTOR']),
  mentorProfileController.getUploadSignature
);

// ========================================
// MENTOR READ-ONLY SCOPE
// ========================================

router.get('/me/dashboard',  authorize(['MENTOR']), mentorReadonlyController.getDashboard);
router.get('/me/students',   authorize(['MENTOR']), mentorReadonlyController.getMyStudents);
router.get('/me/results',    authorize(['MENTOR']), mentorReadonlyController.getMyResults);
router.get('/me/attendance', authorize(['MENTOR']), mentorReadonlyController.getMyAttendance);
router.get('/me/courses',    authorize(['MENTOR']), mentorReadonlyController.getMyCourses);

// ========================================
// CM MANAGEMENT (create / list)
// ========================================

/**
 * @route  POST /api/mentors
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.post('/', authorize(MGMT_ROLES), mentorController.createMentor);

/**
 * @route  GET /api/mentors
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.get('/', authorize(MGMT_ROLES), mentorController.getAllMentors);

// ========================================
// INDIVIDUAL MENTOR ROUTES (/:id last)
// ========================================

/**
 * @route  GET /api/mentors/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER | MENTOR (own)
 */
router.get(
  '/:id',
  isOwnerOrRole('id', MGMT_ROLES),
  mentorController.getOneMentor
);

/**
 * @route  PUT /api/mentors/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.put('/:id', authorize(MGMT_ROLES), mentorController.updateMentor);

/**
 * @route  PATCH /api/mentors/:id/status
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.patch('/:id/status', authorize(MGMT_ROLES), mentorController.updateMentorStatus);

/**
 * @route  PATCH /api/mentors/:id/reset-password
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.patch('/:id/reset-password', authorize(MGMT_ROLES), mentorController.resetMentorPassword);

/**
 * @route  PATCH /api/mentors/:id/restore
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.patch('/:id/restore', authorize(MGMT_ROLES), mentorController.restoreMentor);

/**
 * @route  DELETE /api/mentors/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.delete('/:id', authorize(MGMT_ROLES), mentorController.archiveMentor);

/**
 * @route  DELETE /api/mentors/:id/permanent
 * @access ADMIN only
 */
router.delete('/:id/permanent', authorize(['ADMIN']), mentorController.deleteMentor);

module.exports = router;
