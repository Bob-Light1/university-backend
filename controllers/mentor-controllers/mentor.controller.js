'use strict';

/**
 * @file mentor.controller.js
 * @description Login + CAMPUS_MANAGER-facing CRUD for Mentor accounts.
 *
 *  POST   /api/mentors/login              → loginMentor          (public)
 *  POST   /api/mentors                    → createMentor         (CM)
 *  GET    /api/mentors                    → getAllMentors         (CM)
 *  GET    /api/mentors/:id                → getOneMentor         (CM | MENTOR own)
 *  PUT    /api/mentors/:id                → updateMentor         (CM)
 *  PATCH  /api/mentors/:id/status         → updateMentorStatus   (CM)
 *  PATCH  /api/mentors/:id/reset-password → resetMentorPassword  (CM)
 *  PATCH  /api/mentors/:id/restore        → restoreMentor        (CM)
 *  DELETE /api/mentors/:id                → archiveMentor        (CM)
 *  DELETE /api/mentors/:id/permanent      → deleteMentor         (ADMIN)
 *
 * Campus isolation: CAMPUS_MANAGER is always scoped to req.user.campusId.
 */

const bcrypt   = require('bcrypt');
const jwt      = require('jsonwebtoken');
const mongoose = require('mongoose');

const Mentor     = require('../../models/mentor.model');
const profileSvc = require('../../services/profile.service');
const {
  sendSuccess,
  sendError,
  sendNotFound,
  sendPaginated,
} = require('../../utils/response-helpers');
const {
  isValidEmail,
  isValidObjectId,
  buildCampusFilter,
} = require('../../utils/validation-helpers');

const SALT_ROUNDS = 12;
const JWT_SECRET  = process.env.JWT_SECRET;
const MGMT_ROLES  = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];

// ── Helpers ───────────────────────────────────────────────────────────────────

const buildTokenPayload = (mentor) => ({
  id:       mentor._id,
  campusId: mentor.schoolCampus?._id
              ? mentor.schoolCampus._id.toString()
              : mentor.schoolCampus.toString(),
  role:     'MENTOR',
  name:     `${mentor.firstName} ${mentor.lastName}`,
});

const buildUserResponse = (mentor) => ({
  id:               mentor._id,
  campusId:         mentor.schoolCampus,
  firstName:        mentor.firstName,
  lastName:         mentor.lastName,
  fullName:         mentor.fullName,
  email:            mentor.email,
  username:         mentor.username,
  phone:            mentor.phone,
  profileImage:     mentor.profileImage  ?? null,
  specialization:   mentor.specialization ?? null,
  notificationPrefs: mentor.notificationPrefs,
  status:           mentor.status,
  lastLogin:        mentor.lastLogin     ?? null,
  role:             'MENTOR',
});

const getCampusFilter = (req) => {
  try { return buildCampusFilter(req.user); }
  catch (err) { err.statusCode = 403; throw err; }
};

// ── LOGIN ─────────────────────────────────────────────────────────────────────

/**
 * @route  POST /api/mentors/login
 * @access Public
 */
const loginMentor = async (req, res) => {
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

    const mentor = await Mentor.findOne(query)
      .select('+password')
      .lean({ virtuals: true });

    if (!mentor) return sendError(res, 401, 'Invalid credentials.');

    const isValid = await bcrypt.compare(password, mentor.password);
    if (!isValid) return sendError(res, 401, 'Invalid credentials.');

    if (campusId && mentor.schoolCampus.toString() !== campusId.toString()) {
      return sendError(res, 403, 'You are not registered on this campus.');
    }

    if (mentor.status !== 'active') {
      return sendError(res, 403, 'Your account is not active. Please contact support.');
    }

    const token = jwt.sign(buildTokenPayload(mentor), JWT_SECRET, {
      expiresIn: '7d',
      issuer:    'school-management-app',
    });

    Mentor.findByIdAndUpdate(mentor._id, { lastLogin: new Date() }).exec().catch(() => {});

    return sendSuccess(res, 200, 'Login successful.', {
      token,
      user: buildUserResponse(mentor),
    });

  } catch (err) {
    console.error('❌ loginMentor error:', err);
    return sendError(res, 500, 'Internal server error during login.');
  }
};

// ── CREATE ────────────────────────────────────────────────────────────────────

/**
 * @route  POST /api/mentors
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const createMentor = async (req, res) => {
  try {
    const body = { ...req.body };

    if (req.user.role === 'CAMPUS_MANAGER') {
      body.schoolCampus = req.user.campusId;
    } else if (!body.schoolCampus) {
      return sendError(res, 400, 'schoolCampus is required.');
    }

    delete body.lastLogin;
    delete body.role;

    // Default password if not provided
    if (!body.password) body.password = 'Mentor@123';

    const mentor = await Mentor.create(body);

    const doc = mentor.toObject({ virtuals: true });
    delete doc.password;

    return sendSuccess(res, 201, 'Mentor created successfully.', doc);

  } catch (err) {
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern)[0];
      return sendError(res, 409, `${field} already exists.`);
    }
    if (err.name === 'ValidationError') {
      const errors = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
      return sendError(res, 400, 'Validation failed.', errors);
    }
    console.error('❌ createMentor error:', err);
    return sendError(res, 500, 'Failed to create mentor.');
  }
};

// ── LIST ──────────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/mentors
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 * @query  page, limit, search, status
 */
const getAllMentors = async (req, res) => {
  try {
    const campusFilter = getCampusFilter(req);
    const { page = 1, limit = 20, search, status, includeArchived } = req.query;

    const filter = { ...campusFilter };
    if (status) {
      filter.status = status;
    } else if (includeArchived !== 'true') {
      filter.status = { $ne: 'archived' };
    }
    if (search) {
      const rx = new RegExp(search.trim(), 'i');
      filter.$or = [
        { firstName: rx }, { lastName: rx },
        { email: rx }, { username: rx },
      ];
    }

    const skip  = (Number(page) - 1) * Number(limit);
    const [docs, total] = await Promise.all([
      Mentor.find(filter)
        .select('-password -__v')
        .populate('schoolCampus', 'campus_name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean({ virtuals: true }),
      Mentor.countDocuments(filter),
    ]);

    return sendPaginated(res, 200, 'Mentors retrieved.', docs, { total, page: Number(page), limit: Number(limit) });

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    console.error('❌ getAllMentors error:', err);
    return sendError(res, 500, 'Failed to retrieve mentors.');
  }
};

// ── GET ONE ───────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/mentors/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER | MENTOR (own)
 */
const getOneMentor = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid mentor ID format.');

    const campusFilter = req.user.role === 'MENTOR'
      ? { _id: id, schoolCampus: new mongoose.Types.ObjectId(req.user.campusId) }
      : { ...getCampusFilter(req), _id: id };

    const mentor = await Mentor.findOne(campusFilter)
      .select('-password -__v')
      .populate('schoolCampus', 'campus_name')
      .lean({ virtuals: true });

    if (!mentor) return sendNotFound(res, 'Mentor');
    return sendSuccess(res, 200, 'Mentor retrieved.', mentor);

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    console.error('❌ getOneMentor error:', err);
    return sendError(res, 500, 'Failed to retrieve mentor.');
  }
};

// ── UPDATE ────────────────────────────────────────────────────────────────────

/**
 * @route  PUT /api/mentors/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const updateMentor = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid mentor ID format.');

    const body = { ...req.body };
    // Strip immutable / sensitive fields
    delete body.password;
    delete body.schoolCampus;
    delete body.role;
    delete body.lastLogin;

    const campusFilter = { ...getCampusFilter(req), _id: id };

    const mentor = await Mentor.findOneAndUpdate(
      campusFilter,
      { $set: body },
      { new: true, runValidators: true }
    ).select('-password -__v').lean({ virtuals: true });

    if (!mentor) return sendNotFound(res, 'Mentor');
    return sendSuccess(res, 200, 'Mentor updated.', mentor);

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
    console.error('❌ updateMentor error:', err);
    return sendError(res, 500, 'Failed to update mentor.');
  }
};

// ── UPDATE STATUS ─────────────────────────────────────────────────────────────

/**
 * @route  PATCH /api/mentors/:id/status
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const updateMentorStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid mentor ID format.');

    const allowed = ['active', 'inactive', 'suspended', 'archived'];
    if (!allowed.includes(status)) {
      return sendError(res, 400, `status must be one of: ${allowed.join(', ')}.`);
    }

    const campusFilter = { ...getCampusFilter(req), _id: id };
    const mentor = await Mentor.findOneAndUpdate(
      campusFilter,
      { $set: { status } },
      { new: true }
    ).select('-password -__v').lean({ virtuals: true });

    if (!mentor) return sendNotFound(res, 'Mentor');
    return sendSuccess(res, 200, 'Mentor status updated.', mentor);

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    console.error('❌ updateMentorStatus error:', err);
    return sendError(res, 500, 'Failed to update mentor status.');
  }
};

// ── RESET PASSWORD ────────────────────────────────────────────────────────────

/**
 * @route  PATCH /api/mentors/:id/reset-password
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const resetMentorPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword = 'Mentor@123' } = req.body;

    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid mentor ID format.');

    const campusFilter = { ...getCampusFilter(req), _id: id };
    const mentor = await Mentor.findOne(campusFilter);
    if (!mentor) return sendNotFound(res, 'Mentor');

    const hashed = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await Mentor.findByIdAndUpdate(mentor._id, { password: hashed });

    return sendSuccess(res, 200, 'Mentor password reset successfully.');

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    console.error('❌ resetMentorPassword error:', err);
    return sendError(res, 500, 'Failed to reset mentor password.');
  }
};

// ── ARCHIVE (soft delete) ─────────────────────────────────────────────────────

/**
 * @route  DELETE /api/mentors/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const archiveMentor = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid mentor ID format.');

    const campusFilter = { ...getCampusFilter(req), _id: id };
    const mentor = await Mentor.findOneAndUpdate(
      campusFilter,
      { $set: { status: 'archived' } },
      { new: true }
    ).select('-password -__v').lean({ virtuals: true });

    if (!mentor) return sendNotFound(res, 'Mentor');
    return sendSuccess(res, 200, 'Mentor archived.', mentor);

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    console.error('❌ archiveMentor error:', err);
    return sendError(res, 500, 'Failed to archive mentor.');
  }
};

// ── RESTORE ───────────────────────────────────────────────────────────────────

/**
 * @route  PATCH /api/mentors/:id/restore
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const restoreMentor = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid mentor ID format.');

    const campusFilter = { ...getCampusFilter(req), _id: id };
    const mentor = await Mentor.findOneAndUpdate(
      campusFilter,
      { $set: { status: 'active' } },
      { new: true }
    ).select('-password -__v').lean({ virtuals: true });

    if (!mentor) return sendNotFound(res, 'Mentor');
    return sendSuccess(res, 200, 'Mentor restored.', mentor);

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    console.error('❌ restoreMentor error:', err);
    return sendError(res, 500, 'Failed to restore mentor.');
  }
};

// ── PERMANENT DELETE ──────────────────────────────────────────────────────────

/**
 * @route  DELETE /api/mentors/:id/permanent
 * @access ADMIN only
 */
const deleteMentor = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid mentor ID format.');

    const mentor = await Mentor.findByIdAndDelete(id);
    if (!mentor) return sendNotFound(res, 'Mentor');

    return sendSuccess(res, 200, 'Mentor permanently deleted.');

  } catch (err) {
    console.error('❌ deleteMentor error:', err);
    return sendError(res, 500, 'Failed to delete mentor.');
  }
};

// ── CLOUDINARY UPLOAD SIGNATURE (CM) ─────────────────────────────────────────

/**
 * @route  GET /api/mentors/upload-signature
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const getUploadSignature = (_req, res) => profileSvc.getUploadSignature(res);

module.exports = {
  loginMentor,
  createMentor,
  getAllMentors,
  getOneMentor,
  updateMentor,
  updateMentorStatus,
  resetMentorPassword,
  archiveMentor,
  restoreMentor,
  deleteMentor,
  getUploadSignature,
};
