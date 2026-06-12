'use strict';

/**
 * @file staff.controller.js
 * @description Login + CAMPUS_MANAGER-facing CRUD for Staff accounts.
 *
 *  POST   /api/staff/login               → loginStaff          (public)
 *  POST   /api/staff                     → createStaff         (CM)
 *  GET    /api/staff                     → getAllStaff          (CM)
 *  GET    /api/staff/:id                 → getOneStaff         (CM | STAFF own)
 *  PUT    /api/staff/:id                 → updateStaff         (CM)
 *  PATCH  /api/staff/:id/assign-role     → assignRole          (CM)
 *  PATCH  /api/staff/:id/status          → updateStaffStatus   (CM)
 *  PATCH  /api/staff/:id/reset-password  → resetStaffPassword  (CM)
 *  PATCH  /api/staff/:id/restore         → restoreStaff        (CM)
 *  DELETE /api/staff/:id                 → archiveStaff        (CM)
 *  DELETE /api/staff/:id/permanent       → deleteStaff         (ADMIN)
 *
 * JWT payload for Staff includes a `permissions` array loaded from the
 * assigned StaffRole — no DB lookup needed per request by requirePermission.
 */

const bcrypt   = require('bcrypt');
const jwt      = require('jsonwebtoken');
const mongoose = require('mongoose');

const Staff     = require('../models/staff.model');
const StaffRole = require('../models/staffRole.model');
const profileSvc = require('../../../services/profile.service');
const {
  sendSuccess,
  sendError,
  sendNotFound,
  sendPaginated,
} = require('../../../shared/utils/response-helpers');
const {
  isValidEmail,
  isValidObjectId,
  buildCampusFilter,
  escapeRegex,
} = require('../../../utils/validation-helpers');
const { getLoginPrefs } = require('../../../utils/login-prefs.util');

const SALT_ROUNDS = 12;
const JWT_SECRET  = process.env.JWT_SECRET;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Builds JWT payload. When a staff member has a subRole assigned, the role's
 * permissions array is embedded directly in the token — requirePermission
 * middleware can then check without a DB round-trip.
 */
const buildTokenPayload = (staff, permissions = []) => ({
  id:          staff._id,
  campusId:    staff.schoolCampus?._id
                 ? staff.schoolCampus._id.toString()
                 : staff.schoolCampus.toString(),
  role:        'STAFF',
  subRoleId:   staff.subRole?._id?.toString() ?? staff.subRole?.toString() ?? null,
  subRoleName: staff.subRole?.name ?? null,
  name:        `${staff.firstName} ${staff.lastName}`,
  permissions,
});

const buildUserResponse = (staff, permissions = []) => ({
  id:               staff._id,
  campusId:         staff.schoolCampus,
  firstName:        staff.firstName,
  lastName:         staff.lastName,
  fullName:         staff.fullName,
  email:            staff.email,
  username:         staff.username,
  phone:            staff.phone,
  profileImage:     staff.profileImage  ?? null,
  subRole:          staff.subRole       ?? null,
  notificationPrefs: staff.notificationPrefs,
  status:           staff.status,
  lastLogin:        staff.lastLogin     ?? null,
  role:             'STAFF',
  permissions,
});

const getCampusFilter = (req) => {
  try { return buildCampusFilter(req.user); }
  catch (err) { err.statusCode = 403; throw err; }
};

// ── LOGIN ─────────────────────────────────────────────────────────────────────

/**
 * @route  POST /api/staff/login
 * @access Public
 */
const loginStaff = async (req, res) => {
  try {
    const { email, username, password, campusId } = req.body;

    if ((!email && !username) || !password) {
      return sendError(res, 400, 'Email (or username) and password are required.');
    }
    if (!JWT_SECRET) {
      console.error('❌ JWT_SECRET is not defined');
      return sendError(res, 500, 'Server configuration error.');
    }

    const query = email
      ? { email: email.toLowerCase().trim() }
      : { username: username.toLowerCase().trim() };

    if (email && !isValidEmail(email)) {
      return sendError(res, 400, 'Invalid email format.');
    }

    // Populate subRole to embed permissions in the token
    const staff = await Staff.findOne(query)
      .select('+password')
      .populate('subRole', 'name permissions isActive')
      .lean({ virtuals: true });

    if (!staff) return sendError(res, 401, 'Invalid credentials.');

    const isValid = await bcrypt.compare(password, staff.password);
    if (!isValid) return sendError(res, 401, 'Invalid credentials.');

    if (campusId && staff.schoolCampus.toString() !== campusId.toString()) {
      return sendError(res, 403, 'You are not registered on this campus.');
    }

    if (staff.status !== 'active') {
      return sendError(res, 403, 'Your account is not active. Please contact support.');
    }

    // Extract permissions from assigned subRole (empty array if none)
    const permissions = staff.subRole?.isActive ? (staff.subRole.permissions ?? []) : [];

    const token = jwt.sign(buildTokenPayload(staff, permissions), JWT_SECRET, {
      expiresIn: '7d',
      issuer:    'school-management-app',
    });

    Staff.findByIdAndUpdate(staff._id, { lastLogin: new Date() }).exec().catch(() => {});

    const prefs = await getLoginPrefs(staff._id, 'STAFF', staff.schoolCampus ?? null);

    return sendSuccess(res, 200, 'Login successful.', {
      token,
      user: { ...buildUserResponse(staff, permissions), ...prefs },
    });

  } catch (err) {
    console.error('❌ loginStaff error:', err);
    return sendError(res, 500, 'Internal server error during login.');
  }
};

// ── CREATE ────────────────────────────────────────────────────────────────────

/**
 * @route  POST /api/staff
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const createStaff = async (req, res) => {
  try {
    const body = { ...req.body };

    if (req.user.role === 'CAMPUS_MANAGER') {
      body.schoolCampus = req.user.campusId;
    } else if (!body.schoolCampus) {
      return sendError(res, 400, 'schoolCampus is required.');
    }

    delete body.lastLogin;
    delete body.role;

    // Validate subRole belongs to the same campus
    if (body.subRole) {
      if (!isValidObjectId(body.subRole)) {
        return sendError(res, 400, 'Invalid subRole ID format.');
      }
      const roleDoc = await StaffRole.findOne({
        _id:    body.subRole,
        campus: body.schoolCampus,
        isActive: true,
      }).lean();
      if (!roleDoc) return sendError(res, 404, 'StaffRole not found on this campus.');
    }

    if (!body.password) body.password = 'Staff@123';

    const staff = await Staff.create(body);
    const doc = staff.toObject({ virtuals: true });
    delete doc.password;

    return sendSuccess(res, 201, 'Staff member created successfully.', doc);

  } catch (err) {
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern)[0];
      return sendError(res, 409, `${field} already exists.`);
    }
    if (err.name === 'ValidationError') {
      const errors = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
      return sendError(res, 400, 'Validation failed.', errors);
    }
    console.error('❌ createStaff error:', err);
    return sendError(res, 500, 'Failed to create staff member.');
  }
};

// ── LIST ──────────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/staff
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 * @query  page, limit, search, status, subRole
 */
const getAllStaff = async (req, res) => {
  try {
    const campusFilter = getCampusFilter(req);
    const { page = 1, limit = 20, search, status, subRole, includeArchived } = req.query;

    const filter = { ...campusFilter };
    if (status) {
      filter.status = status;
    } else if (includeArchived !== 'true') {
      filter.status = { $ne: 'archived' };
    }
    if (subRole) filter.subRole = subRole;
    if (search) {
      const rx = new RegExp(escapeRegex(search.trim()), 'i');
      filter.$or = [
        { firstName: rx }, { lastName: rx },
        { email: rx }, { username: rx },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [docs, total] = await Promise.all([
      Staff.find(filter)
        .select('-password -__v')
        .populate('schoolCampus', 'campus_name')
        .populate('subRole', 'name permissions isActive')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean({ virtuals: true }),
      Staff.countDocuments(filter),
    ]);

    return sendPaginated(res, 200, 'Staff retrieved.', docs, { total, page: Number(page), limit: Number(limit) });

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    console.error('❌ getAllStaff error:', err);
    return sendError(res, 500, 'Failed to retrieve staff.');
  }
};

// ── GET ONE ───────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/staff/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER | STAFF (own)
 */
const getOneStaff = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid staff ID format.');

    const campusFilter = req.user.role === 'STAFF'
      ? { _id: id, schoolCampus: new mongoose.Types.ObjectId(req.user.campusId) }
      : { ...getCampusFilter(req), _id: id };

    const staff = await Staff.findOne(campusFilter)
      .select('-password -__v')
      .populate('schoolCampus', 'campus_name')
      .populate('subRole', 'name permissions isActive')
      .lean({ virtuals: true });

    if (!staff) return sendNotFound(res, 'Staff');
    return sendSuccess(res, 200, 'Staff member retrieved.', staff);

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    console.error('❌ getOneStaff error:', err);
    return sendError(res, 500, 'Failed to retrieve staff member.');
  }
};

// ── UPDATE ────────────────────────────────────────────────────────────────────

/**
 * @route  PUT /api/staff/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const updateStaff = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid staff ID format.');

    const body = { ...req.body };
    delete body.password;
    delete body.schoolCampus;
    delete body.role;
    delete body.lastLogin;
    delete body.subRole; // use assignRole endpoint instead

    const campusFilter = { ...getCampusFilter(req), _id: id };

    const staff = await Staff.findOneAndUpdate(
      campusFilter,
      { $set: body },
      { new: true, runValidators: true }
    ).select('-password -__v')
      .populate('subRole', 'name permissions isActive')
      .lean({ virtuals: true });

    if (!staff) return sendNotFound(res, 'Staff');
    return sendSuccess(res, 200, 'Staff member updated.', staff);

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern)[0];
      return sendError(res, 409, `${field} already exists.`);
    }
    if (err.name === 'ValidationError') {
      const errors = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
      return sendError(res, 400, 'Validation failed.', errors);
    }
    console.error('❌ updateStaff error:', err);
    return sendError(res, 500, 'Failed to update staff member.');
  }
};

// ── ASSIGN SUB-ROLE ───────────────────────────────────────────────────────────

/**
 * Attach or detach a StaffRole to a staff member.
 * Passing subRoleId: null removes the role (no permissions).
 *
 * @route  PATCH /api/staff/:id/assign-role
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const assignRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { subRoleId } = req.body;

    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid staff ID format.');

    const campusFilter = getCampusFilter(req);
    const staff = await Staff.findOne({ ...campusFilter, _id: id });
    if (!staff) return sendNotFound(res, 'Staff');

    if (subRoleId !== null && subRoleId !== undefined) {
      if (!isValidObjectId(subRoleId)) return sendError(res, 400, 'Invalid subRoleId format.');
      const role = await StaffRole.findOne({
        _id:      subRoleId,
        campus:   staff.schoolCampus,
        isActive: true,
      }).lean();
      if (!role) return sendError(res, 404, 'StaffRole not found on this campus.');
    }

    await Staff.findByIdAndUpdate(staff._id, {
      $set: { subRole: subRoleId ?? null },
    });

    const updated = await Staff.findById(staff._id)
      .select('-password -__v')
      .populate('subRole', 'name permissions isActive')
      .lean({ virtuals: true });

    return sendSuccess(res, 200, 'Sub-role assigned.', updated);

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    console.error('❌ assignRole error:', err);
    return sendError(res, 500, 'Failed to assign sub-role.');
  }
};

// ── UPDATE STATUS ─────────────────────────────────────────────────────────────

/**
 * @route  PATCH /api/staff/:id/status
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const updateStaffStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid staff ID format.');
    const allowed = ['active', 'inactive', 'suspended', 'archived'];
    if (!allowed.includes(status)) {
      return sendError(res, 400, `status must be one of: ${allowed.join(', ')}.`);
    }

    const staff = await Staff.findOneAndUpdate(
      { ...getCampusFilter(req), _id: id },
      { $set: { status } },
      { new: true }
    ).select('-password -__v').lean({ virtuals: true });

    if (!staff) return sendNotFound(res, 'Staff');
    return sendSuccess(res, 200, 'Staff status updated.', staff);

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    console.error('❌ updateStaffStatus error:', err);
    return sendError(res, 500, 'Failed to update staff status.');
  }
};

// ── RESET PASSWORD ────────────────────────────────────────────────────────────

/**
 * @route  PATCH /api/staff/:id/reset-password
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const resetStaffPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword = 'Staff@123' } = req.body;

    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid staff ID format.');

    const staff = await Staff.findOne({ ...getCampusFilter(req), _id: id });
    if (!staff) return sendNotFound(res, 'Staff');

    const hashed = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await Staff.findByIdAndUpdate(staff._id, { password: hashed });

    return sendSuccess(res, 200, 'Staff password reset successfully.');

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    console.error('❌ resetStaffPassword error:', err);
    return sendError(res, 500, 'Failed to reset staff password.');
  }
};

// ── ARCHIVE ───────────────────────────────────────────────────────────────────

/**
 * @route  DELETE /api/staff/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const archiveStaff = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid staff ID format.');

    const staff = await Staff.findOneAndUpdate(
      { ...getCampusFilter(req), _id: id },
      { $set: { status: 'archived' } },
      { new: true }
    ).select('-password -__v').lean({ virtuals: true });

    if (!staff) return sendNotFound(res, 'Staff');
    return sendSuccess(res, 200, 'Staff member archived.', staff);

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    console.error('❌ archiveStaff error:', err);
    return sendError(res, 500, 'Failed to archive staff member.');
  }
};

// ── RESTORE ───────────────────────────────────────────────────────────────────

/**
 * @route  PATCH /api/staff/:id/restore
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const restoreStaff = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid staff ID format.');

    const staff = await Staff.findOneAndUpdate(
      { ...getCampusFilter(req), _id: id },
      { $set: { status: 'active' } },
      { new: true }
    ).select('-password -__v').lean({ virtuals: true });

    if (!staff) return sendNotFound(res, 'Staff');
    return sendSuccess(res, 200, 'Staff member restored.', staff);

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    console.error('❌ restoreStaff error:', err);
    return sendError(res, 500, 'Failed to restore staff member.');
  }
};

// ── PERMANENT DELETE ──────────────────────────────────────────────────────────

/**
 * @route  DELETE /api/staff/:id/permanent
 * @access ADMIN only
 */
const deleteStaff = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid staff ID format.');

    const staff = await Staff.findByIdAndDelete(id);
    if (!staff) return sendNotFound(res, 'Staff');

    return sendSuccess(res, 200, 'Staff member permanently deleted.');

  } catch (err) {
    console.error('❌ deleteStaff error:', err);
    return sendError(res, 500, 'Failed to delete staff member.');
  }
};

// ── CLOUDINARY UPLOAD SIGNATURE (CM) ─────────────────────────────────────────

/**
 * @route  GET /api/staff/upload-signature
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const getUploadSignature = (_req, res) => profileSvc.getUploadSignature(res);

module.exports = {
  loginStaff,
  createStaff,
  getAllStaff,
  getOneStaff,
  updateStaff,
  assignRole,
  updateStaffStatus,
  resetStaffPassword,
  archiveStaff,
  restoreStaff,
  deleteStaff,
  getUploadSignature,
};
