'use strict';

/**
 * @file staffRole.controller.js
 * @description CRUD for StaffRole sub-role templates (Settings module).
 *
 *  POST   /api/staff-roles        → createStaffRole    (CM)
 *  GET    /api/staff-roles        → getAllStaffRoles    (CM)
 *  GET    /api/staff-roles/:id    → getOneStaffRole     (CM)
 *  PUT    /api/staff-roles/:id    → updateStaffRole     (CM)
 *  PATCH  /api/staff-roles/:id/toggle → toggleStaffRole (CM)
 *  DELETE /api/staff-roles/:id    → deleteStaffRole     (ADMIN | CM)
 *
 * Campus isolation enforced throughout.
 */

const staffRoleRepo = require('../staffRole.repository');
const staffRepo     = require('../staff.repository');
const { ALL_PERMISSIONS } = require('../../../shared/constants/staff-permissions');
const {
  sendSuccess,
  sendError,
  sendNotFound,
  sendPaginated,
} = require('../../../shared/utils/response-helpers');
const {
  isValidObjectId,
  buildCampusFilter,
} = require('../../../shared/utils/validation-helpers');

const getCampusFilter = (req) => {
  try { return buildCampusFilter(req.user); }
  catch (err) { err.statusCode = 403; throw err; }
};

// ── CREATE ────────────────────────────────────────────────────────────────────

/**
 * @route  POST /api/staff-roles
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const createStaffRole = async (req, res) => {
  try {
    const { name, description, permissions = [] } = req.body;

    if (!name?.trim()) return sendError(res, 400, 'Role name is required.');

    const invalid = permissions.filter((p) => !ALL_PERMISSIONS.includes(p));
    if (invalid.length) {
      return sendError(res, 400, `Invalid permissions: ${invalid.join(', ')}.`);
    }

    let campus;
    if (req.user.role === 'CAMPUS_MANAGER') {
      campus = req.user.campusId;
    } else {
      campus = req.body.campus;
      if (!campus) return sendError(res, 400, 'campus is required.');
      if (!isValidObjectId(campus)) return sendError(res, 400, 'Invalid campus ID format.');
    }

    const role = await staffRoleRepo.create({
      campus,
      name:        name.trim(),
      description: description?.trim() ?? undefined,
      permissions: [...new Set(permissions)], // deduplicate
      createdBy:   req.user.id,
    });

    return sendSuccess(res, 201, 'StaffRole created.', role.toObject());

  } catch (err) {
    if (err.code === 11000) {
      return sendError(res, 409, 'A role with this name already exists on this campus.');
    }
    if (err.name === 'ValidationError') {
      const errors = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
      return sendError(res, 400, 'Validation failed.', errors);
    }
    console.error('❌ createStaffRole error:', err);
    return sendError(res, 500, 'Failed to create StaffRole.');
  }
};

// ── LIST ──────────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/staff-roles
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 * @query  page, limit, search, isActive
 */
const getAllStaffRoles = async (req, res) => {
  try {
    const campusFilter = getCampusFilter(req);
    const { page = 1, limit = 50, search, isActive } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const { data: docs, total } = await staffRoleRepo.paginate({
      // buildCampusFilter utilise `schoolCampus` — StaffRole utilise `campus`
      campusScope: campusFilter.schoolCampus,
      isActive:    isActive !== undefined ? isActive === 'true' : undefined,
      search,
      skip,
      limit: Number(limit),
    });

    return sendPaginated(res, 200, 'StaffRoles retrieved.', docs, { total, page: Number(page), limit: Number(limit) });

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    console.error('❌ getAllStaffRoles error:', err);
    return sendError(res, 500, 'Failed to retrieve StaffRoles.');
  }
};

// ── GET ONE ───────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/staff-roles/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const getOneStaffRole = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid StaffRole ID format.');

    const campusFilter = getCampusFilter(req);
    const role = await staffRoleRepo.findOneScoped(id, campusFilter.schoolCampus);

    if (!role) return sendNotFound(res, 'StaffRole');
    return sendSuccess(res, 200, 'StaffRole retrieved.', role);

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    console.error('❌ getOneStaffRole error:', err);
    return sendError(res, 500, 'Failed to retrieve StaffRole.');
  }
};

// ── UPDATE ────────────────────────────────────────────────────────────────────

/**
 * @route  PUT /api/staff-roles/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const updateStaffRole = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid StaffRole ID format.');

    const { name, description, permissions } = req.body;

    if (permissions !== undefined) {
      const invalid = permissions.filter((p) => !ALL_PERMISSIONS.includes(p));
      if (invalid.length) {
        return sendError(res, 400, `Invalid permissions: ${invalid.join(', ')}.`);
      }
    }

    const updates = {};
    if (name        !== undefined) updates.name        = name.trim();
    if (description !== undefined) updates.description = description.trim();
    if (permissions !== undefined) updates.permissions = [...new Set(permissions)];

    if (!Object.keys(updates).length) {
      return sendError(res, 400, 'No updatable fields provided.');
    }

    const campusFilter = getCampusFilter(req);
    const role = await staffRoleRepo.updateScoped(id, campusFilter.schoolCampus, updates);

    if (!role) return sendNotFound(res, 'StaffRole');
    return sendSuccess(res, 200, 'StaffRole updated.', role);

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    if (err.code === 11000) {
      return sendError(res, 409, 'A role with this name already exists on this campus.');
    }
    console.error('❌ updateStaffRole error:', err);
    return sendError(res, 500, 'Failed to update StaffRole.');
  }
};

// ── TOGGLE ACTIVE ─────────────────────────────────────────────────────────────

/**
 * @route  PATCH /api/staff-roles/:id/toggle
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const toggleStaffRole = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid StaffRole ID format.');

    const campusFilter = getCampusFilter(req);
    const current = await staffRoleRepo.findScopedRaw(id, campusFilter.schoolCampus);
    if (!current) return sendNotFound(res, 'StaffRole');

    const role = await staffRoleRepo.setActive(id, !current.isActive);

    return sendSuccess(res, 200, `StaffRole ${role.isActive ? 'activated' : 'deactivated'}.`, role);

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    console.error('❌ toggleStaffRole error:', err);
    return sendError(res, 500, 'Failed to toggle StaffRole.');
  }
};

// ── DELETE ────────────────────────────────────────────────────────────────────

/**
 * Refuses deletion if any staff member currently holds this role.
 *
 * @route  DELETE /api/staff-roles/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const deleteStaffRole = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid StaffRole ID format.');

    const campusFilter = getCampusFilter(req);
    const role = await staffRoleRepo.findScopedRaw(id, campusFilter.schoolCampus);
    if (!role) return sendNotFound(res, 'StaffRole');

    // Safety check: block deletion if the role is in use
    const inUse = await staffRepo.isRoleInUse(role._id);
    if (inUse) {
      return sendError(
        res, 409,
        'This role is assigned to one or more staff members. Reassign or remove them first.'
      );
    }

    await staffRoleRepo.deleteById(role._id);
    return sendSuccess(res, 200, 'StaffRole deleted.');

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    console.error('❌ deleteStaffRole error:', err);
    return sendError(res, 500, 'Failed to delete StaffRole.');
  }
};

module.exports = {
  createStaffRole,
  getAllStaffRoles,
  getOneStaffRole,
  updateStaffRole,
  toggleStaffRole,
  deleteStaffRole,
};
