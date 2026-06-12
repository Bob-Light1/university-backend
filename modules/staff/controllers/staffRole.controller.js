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

const mongoose  = require('mongoose');
const StaffRole = require('../models/staffRole.model');
const Staff     = require('../models/staff.model');
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

    const role = await StaffRole.create({
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

    // buildCampusFilter uses `schoolCampus` key — StaffRole uses `campus`
    const filter = {};
    if (campusFilter.schoolCampus) filter.campus = campusFilter.schoolCampus;

    const { page = 1, limit = 50, search, isActive } = req.query;
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (search) {
      filter.$or = [
        { name:        new RegExp(search.trim(), 'i') },
        { description: new RegExp(search.trim(), 'i') },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [docs, total] = await Promise.all([
      StaffRole.find(filter)
        .populate('campus', 'campus_name')
        .sort({ name: 1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      StaffRole.countDocuments(filter),
    ]);

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
    const filter = { _id: id };
    if (campusFilter.schoolCampus) filter.campus = campusFilter.schoolCampus;

    const role = await StaffRole.findOne(filter)
      .populate('campus', 'campus_name')
      .lean();

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
    const filter = { _id: id };
    if (campusFilter.schoolCampus) filter.campus = campusFilter.schoolCampus;

    const role = await StaffRole.findOneAndUpdate(
      filter,
      { $set: updates },
      { new: true, runValidators: true }
    ).populate('campus', 'campus_name').lean();

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
    const filter = { _id: id };
    if (campusFilter.schoolCampus) filter.campus = campusFilter.schoolCampus;

    const role = await StaffRole.findOne(filter);
    if (!role) return sendNotFound(res, 'StaffRole');

    role.isActive = !role.isActive;
    await role.save();

    return sendSuccess(res, 200, `StaffRole ${role.isActive ? 'activated' : 'deactivated'}.`, role.toObject());

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
    const filter = { _id: id };
    if (campusFilter.schoolCampus) filter.campus = campusFilter.schoolCampus;

    const role = await StaffRole.findOne(filter);
    if (!role) return sendNotFound(res, 'StaffRole');

    // Safety check: block deletion if the role is in use
    const inUse = await Staff.exists({ subRole: role._id });
    if (inUse) {
      return sendError(
        res, 409,
        'This role is assigned to one or more staff members. Reassign or remove them first.'
      );
    }

    await StaffRole.findByIdAndDelete(role._id);
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
