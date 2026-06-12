'use strict';

const express = require('express');
const router  = express.Router();

const staffRoleController = require('./controllers/staffRole.controller');
const { authenticate, authorize } = require('../../shared/middleware/auth');

const MGMT_ROLES = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];

// All routes require authentication
router.use(authenticate);

/**
 * @route  POST /api/staff-roles
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.post('/', authorize(MGMT_ROLES), staffRoleController.createStaffRole);

/**
 * @route  GET /api/staff-roles
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 * @query  page, limit, search, isActive
 */
router.get('/', authorize(MGMT_ROLES), staffRoleController.getAllStaffRoles);

/**
 * @route  GET /api/staff-roles/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.get('/:id', authorize(MGMT_ROLES), staffRoleController.getOneStaffRole);

/**
 * @route  PUT /api/staff-roles/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.put('/:id', authorize(MGMT_ROLES), staffRoleController.updateStaffRole);

/**
 * @route  PATCH /api/staff-roles/:id/toggle
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.patch('/:id/toggle', authorize(MGMT_ROLES), staffRoleController.toggleStaffRole);

/**
 * @route  DELETE /api/staff-roles/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.delete('/:id', authorize(MGMT_ROLES), staffRoleController.deleteStaffRole);

module.exports = router;
