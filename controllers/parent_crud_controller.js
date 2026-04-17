'use strict';

/**
 * @file parent_crud_controller.js
 * @description Admin-facing CRUD operations for the Parent entity.
 *
 *  Routes handled:
 *  ─────────────────────────────────────────────────────────────────
 *  POST   /api/parents                    → createParent
 *  GET    /api/parents                    → getAllParents
 *  GET    /api/parents/:id                → getParentById
 *  PUT    /api/parents/:id                → updateParent
 *  PATCH  /api/parents/:id/status         → updateParentStatus
 *  PATCH  /api/parents/:id/children       → updateParentChildren
 *  PATCH  /api/parents/:id/reset-password → resetParentPassword
 *  DELETE /api/parents/:id                → deleteParent
 *
 *  Campus isolation: CAMPUS_MANAGER is always scoped to req.user.campusId.
 *  ADMIN / DIRECTOR have cross-campus access.
 */

const crypto   = require('crypto');
const bcrypt   = require('bcrypt');
const mongoose = require('mongoose');

const Parent  = require('../models/parent.model');
const Student = require('../models/student.model');
const {
  sendSuccess,
  sendError,
  sendNotFound,
  sendPaginated,
  handleDuplicateKeyError,
} = require('../utils/responseHelpers');
const {
  isValidObjectId,
  buildCampusFilter,
} = require('../utils/validationHelpers');

const SALT_ROUNDS  = 12;
const MGMT_ROLES   = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];
const GLOBAL_ROLES = ['ADMIN', 'DIRECTOR'];

// ── AUDIT LOG ─────────────────────────────────────────────────────────────────

/**
 * Emits a structured log for sensitive management actions.
 * Never logs email, phone, or password fields.
 */
const auditLog = (req, action, entityId) => {
  console.warn(JSON.stringify({
    actor:     req.user.id,
    role:      req.user.role,
    action,
    entityId:  String(entityId),
    campusId:  req.user.campusId ?? 'GLOBAL',
    timestamp: new Date().toISOString(),
  }));
};

// ── CAMPUS FILTER HELPER ──────────────────────────────────────────────────────

/**
 * Returns a Mongoose filter that enforces campus isolation.
 * Throws 403 if a non-global role has no campusId in their JWT.
 */
const getCampusFilter = (req) => {
  try {
    return buildCampusFilter(req.user);
  } catch (err) {
    err.statusCode = 403;
    throw err;
  }
};

// ── CREATE ────────────────────────────────────────────────────────────────────

/**
 * Create a new parent account.
 * CAMPUS_MANAGER: campus is forced to their own campusId.
 * ADMIN/DIRECTOR: must supply schoolCampus in the body.
 *
 * @route  POST /api/parents
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const createParent = async (req, res) => {
  try {
    const body = { ...req.body };

    // Determine campus
    if (req.user.role === 'CAMPUS_MANAGER') {
      body.schoolCampus = req.user.campusId;
    } else if (!body.schoolCampus) {
      return sendError(res, 400, 'schoolCampus is required.');
    }

    // Strip fields that must not be set by the caller
    delete body.parentRef;
    delete body.isArchived;
    delete body.lastLogin;

    // Strip notes for non-admin roles
    if (!GLOBAL_ROLES.includes(req.user.role) && req.user.role !== 'CAMPUS_MANAGER') {
      delete body.notes;
    }

    const parent = await Parent.create(body);

    auditLog(req, 'CREATE_PARENT', parent._id);

    const populated = await Parent.findById(parent._id)
      .select('-password -__v')
      .populate('schoolCampus', 'campus_name')
      .populate('children',     'firstName lastName')
      .lean({ virtuals: true });

    return sendSuccess(res, 201, 'Parent account created successfully.', populated);

  } catch (error) {
    if (error.code === 11000) return handleDuplicateKeyError(res, error);
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map((e) => ({ field: e.path, message: e.message }));
      return sendError(res, 400, 'Validation failed.', errors);
    }
    console.error('❌ createParent error:', error);
    return sendError(res, 500, 'Failed to create parent account.');
  }
};

// ── LIST ──────────────────────────────────────────────────────────────────────

/**
 * List parents with pagination and filtering.
 * CAMPUS_MANAGER is locked to their own campus.
 *
 * Query params:
 *   page, limit, status, search (firstName|lastName|email), campusId (ADMIN/DIR only)
 *
 * @route  GET /api/parents
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const getAllParents = async (req, res) => {
  try {
    const campusFilter = getCampusFilter(req);

    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip  = (page - 1) * limit;

    const filter = { ...campusFilter, isArchived: false };

    // Optional campusId override for ADMIN/DIRECTOR
    if (GLOBAL_ROLES.includes(req.user.role) && req.query.campusId) {
      if (isValidObjectId(req.query.campusId)) {
        filter.schoolCampus = new mongoose.Types.ObjectId(req.query.campusId);
      }
    }

    // Status filter
    if (req.query.status && ['active', 'inactive', 'suspended'].includes(req.query.status)) {
      filter.status = req.query.status;
    }

    // Search by name or email
    if (req.query.search) {
      const rx = new RegExp(req.query.search.trim(), 'i');
      filter.$or = [
        { firstName: rx },
        { lastName:  rx },
        { email:     rx },
        { parentRef: rx },
      ];
    }

    const [data, total] = await Promise.all([
      Parent.find(filter)
        .select('-password -__v -notes')
        .populate('schoolCampus', 'campus_name')
        .populate('children',     'firstName lastName profileImage')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean({ virtuals: true }),
      Parent.countDocuments(filter),
    ]);

    return sendPaginated(res, 200, 'Parents retrieved successfully.', data, { total, page, limit });

  } catch (error) {
    if (error.statusCode === 403) return sendError(res, 403, error.message);
    console.error('❌ getAllParents error:', error);
    return sendError(res, 500, 'Failed to retrieve parents.');
  }
};

// ── GET ONE ───────────────────────────────────────────────────────────────────

/**
 * Get a single parent by ID with populated children.
 *
 * @route  GET /api/parents/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const getParentById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid parent ID format.');

    const campusFilter = getCampusFilter(req);

    const parent = await Parent.findOne({ _id: id, ...campusFilter, isArchived: false })
      .select('-password -__v')
      .populate('schoolCampus', 'campus_name location')
      .populate('children',     'firstName lastName profileImage studentClass status')
      .lean({ virtuals: true });

    if (!parent) return sendNotFound(res, 'Parent');

    return sendSuccess(res, 200, 'Parent retrieved successfully.', parent);

  } catch (error) {
    if (error.statusCode === 403) return sendError(res, 403, error.message);
    console.error('❌ getParentById error:', error);
    return sendError(res, 500, 'Failed to retrieve parent.');
  }
};

// ── UPDATE ────────────────────────────────────────────────────────────────────

/**
 * Full update of a parent's profile (admin-facing).
 * Protected fields that cannot be updated here: password, parentRef, isArchived, lastLogin.
 *
 * @route  PUT /api/parents/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const updateParent = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid parent ID format.');

    const campusFilter = getCampusFilter(req);

    // Strip immutable / sensitive fields
    const { password, parentRef, isArchived, lastLogin, schoolCampus: _sc, ...updates } = req.body;

    // CAMPUS_MANAGER cannot move a parent to a different campus
    // ADMIN/DIRECTOR can (but we don't expose it through this endpoint either — use createParent)

    const parent = await Parent.findOneAndUpdate(
      { _id: id, ...campusFilter, isArchived: false },
      { $set: updates },
      { new: true, runValidators: true }
    )
      .select('-password -__v')
      .populate('schoolCampus', 'campus_name')
      .populate('children',     'firstName lastName')
      .lean({ virtuals: true });

    if (!parent) return sendNotFound(res, 'Parent');

    return sendSuccess(res, 200, 'Parent updated successfully.', parent);

  } catch (error) {
    if (error.statusCode === 403) return sendError(res, 403, error.message);
    if (error.code === 11000)     return handleDuplicateKeyError(res, error);
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map((e) => ({ field: e.path, message: e.message }));
      return sendError(res, 400, 'Validation failed.', errors);
    }
    console.error('❌ updateParent error:', error);
    return sendError(res, 500, 'Failed to update parent.');
  }
};

// ── STATUS ────────────────────────────────────────────────────────────────────

/**
 * Change a parent's account status (active / inactive / suspended).
 *
 * Body: { status: 'active' | 'inactive' | 'suspended' }
 *
 * @route  PATCH /api/parents/:id/status
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const updateParentStatus = async (req, res) => {
  try {
    const { id }     = req.params;
    const { status } = req.body;

    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid parent ID format.');

    if (!['active', 'inactive', 'suspended'].includes(status)) {
      return sendError(res, 400, "status must be 'active', 'inactive', or 'suspended'.");
    }

    const campusFilter = getCampusFilter(req);

    const parent = await Parent.findOneAndUpdate(
      { _id: id, ...campusFilter, isArchived: false },
      { $set: { status } },
      { new: true }
    )
      .select('-password -__v -notes')
      .lean({ virtuals: true });

    if (!parent) return sendNotFound(res, 'Parent');

    auditLog(req, `UPDATE_PARENT_STATUS_${status.toUpperCase()}`, id);

    return sendSuccess(res, 200, `Parent status updated to '${status}'.`, { id: parent._id, status: parent.status });

  } catch (error) {
    if (error.statusCode === 403) return sendError(res, 403, error.message);
    console.error('❌ updateParentStatus error:', error);
    return sendError(res, 500, 'Failed to update parent status.');
  }
};

// ── LINK / UNLINK CHILDREN ────────────────────────────────────────────────────

/**
 * Replace the parent's children[] array entirely.
 * Each studentId is validated to exist AND belong to the parent's campus.
 *
 * Body: { children: [ObjectId, ...] }  (max 10)
 *
 * @route  PATCH /api/parents/:id/children
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const updateParentChildren = async (req, res) => {
  try {
    const { id }       = req.params;
    const { children } = req.body;

    if (!isValidObjectId(id))   return sendError(res, 400, 'Invalid parent ID format.');
    if (!Array.isArray(children)) return sendError(res, 400, 'children must be an array.');
    if (children.length > 10)   return sendError(res, 400, 'A parent cannot have more than 10 children.');

    const campusFilter = getCampusFilter(req);

    // Fetch parent to get schoolCampus
    const parent = await Parent.findOne({ _id: id, ...campusFilter, isArchived: false })
      .select('schoolCampus');
    if (!parent) return sendNotFound(res, 'Parent');

    const campusStr = parent.schoolCampus.toString();

    // Validate each studentId: exists + same campus
    const invalidIds = [];
    if (children.length > 0) {
      const students = await Student.find({ _id: { $in: children } })
        .select('_id schoolCampus')
        .lean();

      const foundMap = new Map(students.map((s) => [s._id.toString(), s]));

      for (const childId of children) {
        const s = foundMap.get(childId.toString());
        if (!s) {
          invalidIds.push({ id: childId, reason: 'Student not found.' });
        } else if (s.schoolCampus.toString() !== campusStr) {
          invalidIds.push({ id: childId, reason: 'Student does not belong to this campus.' });
        }
      }
    }

    if (invalidIds.length > 0) {
      return sendError(res, 400, 'Some student IDs are invalid.', invalidIds);
    }

    const updated = await Parent.findByIdAndUpdate(
      id,
      { $set: { children } },
      { new: true, runValidators: true }
    )
      .select('-password -__v -notes')
      .populate('children', 'firstName lastName profileImage')
      .lean({ virtuals: true });

    auditLog(req, 'UPDATE_PARENT_CHILDREN', id);

    return sendSuccess(res, 200, 'Children updated successfully.', { id: updated._id, children: updated.children });

  } catch (error) {
    if (error.statusCode === 403) return sendError(res, 403, error.message);
    console.error('❌ updateParentChildren error:', error);
    return sendError(res, 500, 'Failed to update children.');
  }
};

// ── RESET PASSWORD ────────────────────────────────────────────────────────────

/**
 * Admin-initiated password reset.
 * Generates a random temporary password, hashes it, and saves.
 * The temp password is returned only in the response body (no email integration here).
 * In production, the temp password should be sent via email/SMS instead.
 *
 * @route  PATCH /api/parents/:id/reset-password
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const resetParentPassword = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid parent ID format.');

    const campusFilter = getCampusFilter(req);

    const parent = await Parent.findOne({ _id: id, ...campusFilter, isArchived: false })
      .select('+password');
    if (!parent) return sendNotFound(res, 'Parent');

    // Generate a secure random temporary password
    const tempPassword = crypto.randomBytes(8).toString('hex'); // 16-char hex string
    const salt         = await bcrypt.genSalt(SALT_ROUNDS);
    const hashed       = await bcrypt.hash(tempPassword, salt);

    await Parent.findByIdAndUpdate(id, { password: hashed });

    auditLog(req, 'RESET_PARENT_PASSWORD', id);

    // Return temp password — in production, send via email/SMS and omit from response
    return sendSuccess(res, 200, 'Password reset successfully.', {
      success:       true,
      tempPassword,  // TODO: replace with email/SMS delivery in production
    });

  } catch (error) {
    if (error.statusCode === 403) return sendError(res, 403, error.message);
    console.error('❌ resetParentPassword error:', error);
    return sendError(res, 500, 'Failed to reset password.');
  }
};

// ── DELETE ────────────────────────────────────────────────────────────────────

/**
 * Delete a parent.
 *  - CAMPUS_MANAGER / DIRECTOR : soft-delete (isArchived = true)
 *  - ADMIN                     : hard-delete (permanent removal from DB)
 *
 * @route  DELETE /api/parents/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const deleteParent = async (req, res) => {
  try {
    const { id }   = req.params;
    const hardDelete = req.user.role === 'ADMIN' && req.query.hard === 'true';

    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid parent ID format.');

    const campusFilter = getCampusFilter(req);

    if (hardDelete) {
      const parent = await Parent.findOneAndDelete({ _id: id, ...campusFilter });
      if (!parent) return sendNotFound(res, 'Parent');

      auditLog(req, 'HARD_DELETE_PARENT', id);
      return sendSuccess(res, 200, 'Parent permanently deleted.');
    }

    // Soft-delete
    const parent = await Parent.findOneAndUpdate(
      { _id: id, ...campusFilter, isArchived: false },
      { $set: { isArchived: true } },
      { new: true }
    );
    if (!parent) return sendNotFound(res, 'Parent');

    auditLog(req, 'SOFT_DELETE_PARENT', id);
    return sendSuccess(res, 200, 'Parent archived successfully.');

  } catch (error) {
    if (error.statusCode === 403) return sendError(res, 403, error.message);
    console.error('❌ deleteParent error:', error);
    return sendError(res, 500, 'Failed to delete parent.');
  }
};

// ── EXPORTS ───────────────────────────────────────────────────────────────────

module.exports = {
  createParent,
  getAllParents,
  getParentById,
  updateParent,
  updateParentStatus,
  updateParentChildren,
  resetParentPassword,
  deleteParent,
};
