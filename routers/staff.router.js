'use strict';

const express = require('express');
const router  = express.Router();

const staffController         = require('../controllers/staff-controllers/staff.controller');
const staffProfileController  = require('../controllers/staff-controllers/staff.profile.controller');
const staffReadonlyController = require('../controllers/staff-controllers/staff.readonly.controller');
const { authenticate, authorize, isOwnerOrRole, requirePermission } = require('../middleware/auth/auth');
const { loginLimiter } = require('../middleware/rate-limiter/rate-limiter');

const MGMT_ROLES = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];

// ========================================
// PUBLIC ROUTES
// ========================================

/**
 * @route  POST /api/staff/login
 * @access Public
 */
router.post('/login', loginLimiter, staffController.loginStaff);

// ========================================
// PROTECTED ROUTES
// ========================================
router.use(authenticate);

// ========================================
// STAFF SELF-SERVICE  (/me/* before /:id)
// ========================================

router.get(
  '/me',
  authorize(['STAFF']),
  staffProfileController.getMe
);

router.patch(
  '/me/profile',
  authorize(['STAFF']),
  staffProfileController.updateProfile
);

router.patch(
  '/me/password',
  authorize(['STAFF']),
  staffProfileController.changePassword
);

router.patch(
  '/me/profile-image',
  authorize(['STAFF']),
  staffProfileController.uploadProfileImage
);

router.patch(
  '/me/notifications',
  authorize(['STAFF']),
  staffProfileController.updateNotifications
);

router.get(
  '/me/upload-signature',
  authorize(['STAFF']),
  staffProfileController.getUploadSignature
);

// ========================================
// STAFF READ-ONLY SCOPE (/me/dashboard, /me/students…)
// ========================================

router.get('/me/dashboard',  authorize(['STAFF']), staffReadonlyController.getDashboard);
router.get('/me/students',   authorize(['STAFF']), requirePermission('students.read'),   staffReadonlyController.getMyStudents);
router.get('/me/attendance', authorize(['STAFF']), requirePermission('attendance.read'), staffReadonlyController.getMyAttendance);
router.get('/me/results',    authorize(['STAFF']), requirePermission('results.read'),    staffReadonlyController.getMyResults);
router.get('/me/courses',    authorize(['STAFF']), requirePermission('courses.read'),    staffReadonlyController.getMyCourses);

// ========================================
// CM MANAGEMENT (create / list)
// ========================================

/**
 * @route  POST /api/staff
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.post('/', authorize(MGMT_ROLES), staffController.createStaff);

/**
 * @route  GET /api/staff
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.get('/', authorize(MGMT_ROLES), staffController.getAllStaff);

// ========================================
// INDIVIDUAL STAFF ROUTES (/:id last)
// ========================================

/**
 * @route  GET /api/staff/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER | STAFF (own)
 */
router.get(
  '/:id',
  isOwnerOrRole('id', MGMT_ROLES),
  staffController.getOneStaff
);

/**
 * @route  PUT /api/staff/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.put('/:id', authorize(MGMT_ROLES), staffController.updateStaff);

/**
 * @route  PATCH /api/staff/:id/assign-role
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.patch('/:id/assign-role', authorize(MGMT_ROLES), staffController.assignRole);

/**
 * @route  PATCH /api/staff/:id/status
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.patch('/:id/status', authorize(MGMT_ROLES), staffController.updateStaffStatus);

/**
 * @route  PATCH /api/staff/:id/reset-password
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.patch('/:id/reset-password', authorize(MGMT_ROLES), staffController.resetStaffPassword);

/**
 * @route  PATCH /api/staff/:id/restore
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.patch('/:id/restore', authorize(MGMT_ROLES), staffController.restoreStaff);

/**
 * @route  DELETE /api/staff/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.delete('/:id', authorize(MGMT_ROLES), staffController.archiveStaff);

/**
 * @route  DELETE /api/staff/:id/permanent
 * @access ADMIN only
 */
router.delete('/:id/permanent', authorize(['ADMIN']), staffController.deleteStaff);

module.exports = router;
