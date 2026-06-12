const express = require('express');
const router = express.Router();

const departmentController = require('./controllers/department.controller');
const { authenticate, authorize } = require('../../shared/middleware/auth');
const { apiLimiter } = require('../../shared/middleware/rate-limiter');

// Role configurations
const ADMIN_ROLES = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];

// ============================================================
// ALL ROUTES REQUIRE AUTHENTICATION
// ============================================================
router.use(authenticate);

/**
 * @route   POST /api/department
 * @desc    Create a new department
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.post(
  '/',
  authorize(ADMIN_ROLES),
  departmentController.createDepartment
);

/**
 * @route   GET /api/department
 * @desc    Get all departments (filtered by campus)
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER, TEACHER
 * @query   campusId, search, status, includeArchived, page, limit
 */
router.get(
  '/',
  apiLimiter,
  departmentController.getAllDepartments
);

/**
 * @route   GET /api/department/stats/:campusId
 * @desc    Get department statistics for a campus
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.get(
  '/stats/:campusId',
  authorize(ADMIN_ROLES),
  departmentController.getDepartmentStats
);

/**
 * @route   GET /api/department/:id
 * @desc    Get a single department by ID
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER, TEACHER
 */
router.get(
  '/:id',
  departmentController.getOneDepartment
);

/**
 * @route   PUT /api/department/:id
 * @desc    Update department information
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.put(
  '/:id',
  authorize(ADMIN_ROLES),
  departmentController.updateDepartment
);

/**
 * @route   DELETE /api/department/:id
 * @desc    Archive department (soft delete)
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 * @note    Blocked if active teachers are still assigned
 */
router.delete(
  '/:id',
  authorize(ADMIN_ROLES),
  departmentController.archiveDepartment
);

/**
 * @route   PATCH /api/department/:id/restore
 * @desc    Restore archived department
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.patch(
  '/:id/restore',
  authorize(ADMIN_ROLES),
  departmentController.restoreDepartment
);

module.exports = router;