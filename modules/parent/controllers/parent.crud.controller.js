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

const parentRepo = require('../parent.repository');
const studentService = require('../../student').service; // student module facade (§3)
const {
  sendSuccess,
  sendError,
  sendNotFound,
  sendPaginated,
  handleDuplicateKeyError,
} = require('../../../shared/utils/response-helpers');
const {
  isValidObjectId,
  buildCampusFilter,
} = require('../../../shared/utils/validation-helpers');

const { getFileUrl } = require('../../../shared/middleware/upload');

const SALT_ROUNDS  = 12;
const MGMT_ROLES   = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];
const GLOBAL_ROLES = ['ADMIN', 'DIRECTOR'];

/**
 * Normalize a field that multer may deliver as a bare string when only one
 * value is appended (fd.append('children', id) × 1 → string, not array).
 */
const toArray = (v) => {
  if (v === undefined || v === null) return undefined;
  return Array.isArray(v) ? v : [v];
};

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
    delete body.lastLogin;

    // Profile image uploaded via multer (multipart/form-data)
    if (req.file) {
      body.profileImage = getFileUrl(req.file);
    }

    // Normalize children: multer returns a string when only 1 value is sent
    if (body.children !== undefined) {
      body.children = toArray(body.children) ?? [];
    }

    // The account starts 'pending' with an unusable placeholder password.
    // The parent sets their own password through the activation flow — no
    // default password is ever issued (see modules/account).
    delete body.status;
    body.status   = 'pending';
    body.password = crypto.randomBytes(24).toString('hex');

    const parent = await parentRepo.create(body);

    // Issue the activation token: sends account.activate (when an email exists)
    // and returns the link + offline code ONCE for the admin to relay.
    const activation = await require('../../account').service.issueActivationToken({
      userModel: 'Parent',
      userId:    parent._id,
      campusId:  parent.schoolCampus,
      email:     parent.email || null,
      name:      parent.firstName,
      locale:    parent.preferredLanguage,
      createdBy: req.user.id,
    });

    auditLog(req, 'CREATE_PARENT', parent._id);

    const populated = await parentRepo.findByIdForResponse(parent._id);

    return sendSuccess(res, 201, 'Parent account created. Share the activation link or code with the parent.', { ...(populated.toObject ? populated.toObject() : populated), activation });

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

    // includeArchived toggle — mirrors the behaviour of GenericEntityController
    const includeArchived = req.query.includeArchived === 'true';

    // Optional campusId override for ADMIN/DIRECTOR (validated here)
    let campusIdOverride;
    if (GLOBAL_ROLES.includes(req.user.role) && req.query.campusId && isValidObjectId(req.query.campusId)) {
      campusIdOverride = new mongoose.Types.ObjectId(req.query.campusId);
    }

    // Status filter — 'archived' is only meaningful when includeArchived=true.
    const allowedStatuses = includeArchived
      ? ['active', 'inactive', 'suspended', 'archived']
      : ['active', 'inactive', 'suspended'];
    const status = req.query.status && allowedStatuses.includes(req.query.status) ? req.query.status : undefined;

    const VALID_RELATIONSHIPS = ['father', 'mother', 'guardian', 'other'];
    const relationship = req.query.relationship && VALID_RELATIONSHIPS.includes(req.query.relationship)
      ? req.query.relationship : undefined;

    const { data, total } = await parentRepo.paginate({
      campusFilter,
      includeArchived,
      campusIdOverride,
      status,
      relationship,
      search: req.query.search,
      skip,
      limit,
    });

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

    const parent = await parentRepo.findScopedDetailed(id, campusFilter);

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
 * Protected fields that cannot be updated here: password, parentRef, lastLogin.
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
    const { password, parentRef, lastLogin, schoolCampus: _sc, ...updates } = req.body;

    // Profile image uploaded via multer (multipart/form-data)
    if (req.file) {
      updates.profileImage = getFileUrl(req.file);
    }

    // Normalize children: multer returns a string when only 1 value is sent
    if (updates.children !== undefined) {
      updates.children = toArray(updates.children) ?? [];
    }

    const parent = await parentRepo.updateScoped(id, campusFilter, updates);

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

    // A 'pending' account has no usable password yet — forcing it to 'active'
    // here would create a login-able status with credentials nobody knows.
    // Activation (or reset-password) is the only path out of 'pending'.
    const existing = await parentRepo.findActiveScoped(id, campusFilter);
    if (!existing) return sendNotFound(res, 'Parent');
    if (existing.status === 'pending') {
      return sendError(
        res,
        409,
        'This account is awaiting activation. It will become active automatically once the parent activates it; re-issue an activation link via reset-password if needed.'
      );
    }

    const parent = await parentRepo.setStatusScoped(id, campusFilter, status);

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
    const parent = await parentRepo.findActiveScoped(id, campusFilter);
    if (!parent) return sendNotFound(res, 'Parent');

    const campusStr = parent.schoolCampus.toString();

    // Validate each studentId: exists + same campus
    const invalidIds = [];
    if (children.length > 0) {
      const students = await studentService.getStudentsCampusRefs(children);

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

    const updated = await parentRepo.setChildren(id, children);

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
 *
 * Rather than handing out a plaintext temporary password (which would have to
 * be relayed over an insecure channel), this scrambles the current password,
 * flips the account back to 'pending', and re-issues an activation token so the
 * parent chooses their own new password — same secure path as account creation.
 * The activation link + offline code are returned ONCE for the admin to relay.
 *
 * @route  PATCH /api/parents/:id/reset-password
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const resetParentPassword = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid parent ID format.');

    const campusFilter = getCampusFilter(req);

    // Scramble the existing password so the old credentials stop working
    // immediately. The value is never disclosed — it is replaced on activation.
    const placeholder = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), SALT_ROUNDS);

    const parent = await parentRepo.resetForReactivation(id, campusFilter, placeholder);
    if (!parent) return sendNotFound(res, 'Parent');

    const activation = await require('../../account').service.issueActivationToken({
      userModel: 'Parent',
      userId:    parent._id,
      campusId:  parent.schoolCampus,
      email:     parent.email || null,
      name:      parent.firstName,
      locale:    parent.preferredLanguage,
      createdBy: req.user.id,
    });

    auditLog(req, 'RESET_PARENT_PASSWORD', id);

    return sendSuccess(res, 200, 'Password reset. Share the new activation link or code with the parent.', { activation });

  } catch (error) {
    if (error.statusCode === 403) return sendError(res, 403, error.message);
    console.error('❌ resetParentPassword error:', error);
    return sendError(res, 500, 'Failed to reset password.');
  }
};

// ── DELETE ────────────────────────────────────────────────────────────────────

/**
 * Delete a parent.
 *  - CAMPUS_MANAGER / DIRECTOR : soft-delete (status = 'archived')
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
      const parent = await parentRepo.hardDeleteScoped(id, campusFilter);
      if (!parent) return sendNotFound(res, 'Parent');

      auditLog(req, 'HARD_DELETE_PARENT', id);
      return sendSuccess(res, 200, 'Parent permanently deleted.');
    }

    // Soft-delete
    const parent = await parentRepo.archiveScoped(id, campusFilter);
    if (!parent) return sendNotFound(res, 'Parent');

    auditLog(req, 'SOFT_DELETE_PARENT', id);
    return sendSuccess(res, 200, 'Parent archived successfully.');

  } catch (error) {
    if (error.statusCode === 403) return sendError(res, 403, error.message);
    console.error('❌ deleteParent error:', error);
    return sendError(res, 500, 'Failed to delete parent.');
  }
};

// ── RESTORE ───────────────────────────────────────────────────────────────────

/**
 * Restore an archived parent.
 *
 * @route  PATCH /api/parents/:id/restore
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const restoreParent = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid parent ID format.');

    const campusFilter = getCampusFilter(req);

    const parent = await parentRepo.restoreScoped(id, campusFilter);

    if (!parent) return sendNotFound(res, 'Archived parent');

    auditLog(req, 'RESTORE_PARENT', id);
    return sendSuccess(res, 200, 'Parent restored successfully.');

  } catch (error) {
    if (error.statusCode === 403) return sendError(res, 403, error.message);
    console.error('❌ restoreParent error:', error);
    return sendError(res, 500, 'Failed to restore parent.');
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
  restoreParent,
};
