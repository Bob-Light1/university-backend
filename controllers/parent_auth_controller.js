'use strict';

/**
 * @file parent_auth_controller.js
 * @description Authentication & self-service endpoints for the PARENT role.
 *
 *  Routes handled:
 *  ─────────────────────────────────────────────────────────────────
 *  POST  /api/parents/login              → loginParent        (public)
 *  GET   /api/parents/me                 → getMe              (PARENT)
 *  PUT   /api/parents/me/password        → updatePassword     (PARENT)
 *  PUT   /api/parents/me/profile         → updateProfile      (PARENT)
 *  POST  /api/parents/me/profile-image   → uploadProfileImage (PARENT)
 */

const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');

const Parent  = require('../models/parent.model');
const {
  sendSuccess,
  sendError,
  sendNotFound,
} = require('../utils/responseHelpers');
const {
  isValidEmail,
  validatePasswordStrength,
} = require('../utils/validationHelpers');

const SALT_ROUNDS = 12;
const JWT_SECRET  = process.env.JWT_SECRET;

// ── HELPERS ───────────────────────────────────────────────────────────────────

/**
 * Builds the minimal JWT payload for a parent.
 * IMPORTANT: campusId must be a plain string — populated objects would
 * break buildCampusFilter (isValidObjectId rejects plain objects).
 */
const buildTokenPayload = (parent) => ({
  id:       parent._id,
  campusId: parent.schoolCampus?._id
              ? parent.schoolCampus._id.toString()
              : parent.schoolCampus.toString(),
  role:     'PARENT',
  name:     `${parent.firstName} ${parent.lastName}`,
  children: parent.children,
});

/**
 * Builds the safe user object returned in the login response body.
 * Never includes password, __v, isArchived, or notes.
 */
const buildUserResponse = (parent) => ({
  id:               parent._id,
  parentRef:        parent.parentRef,
  campusId:         parent.schoolCampus,
  firstName:        parent.firstName,
  lastName:         parent.lastName,
  fullName:         parent.fullName,
  email:            parent.email,
  phone:            parent.phone,
  gender:           parent.gender,
  relationship:     parent.relationship,
  profileImage:     parent.profileImage  ?? null,
  preferredLanguage: parent.preferredLanguage,
  notificationPrefs: parent.notificationPrefs,
  children:         parent.children,
  status:           parent.status,
  lastLogin:        parent.lastLogin     ?? null,
  role:             'PARENT',
});

// ── LOGIN ─────────────────────────────────────────────────────────────────────

/**
 * Authenticate a parent and return a JWT.
 *
 * Body: { email, password, campusId? }
 *  - campusId is optional but strongly recommended by the UI.
 *    When supplied, the parent must belong to that campus (campus isolation).
 *
 * @route  POST /api/parents/login
 * @access Public
 */
const loginParent = async (req, res) => {
  try {
    const { email, password, campusId } = req.body;

    if (!email || !password) {
      return sendError(res, 400, 'Email and password are required.');
    }

    if (!JWT_SECRET) {
      console.error('❌ JWT_SECRET is not defined');
      return sendError(res, 500, 'Server configuration error.');
    }

    if (!isValidEmail(email)) {
      return sendError(res, 400, 'Invalid email format.');
    }

    // Fetch parent with password (select:false by default)
    const parent = await Parent.findOne({ email: email.toLowerCase().trim() })
      .select('+password')
      .lean({ virtuals: true });

    // Generic error — never reveal whether the account exists
    if (!parent) {
      return sendError(res, 401, 'Invalid credentials.');
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, parent.password);
    if (!isPasswordValid) {
      return sendError(res, 401, 'Invalid credentials.');
    }

    // Campus isolation check — must match the campus the parent belongs to
    if (campusId && parent.schoolCampus.toString() !== campusId.toString()) {
      return sendError(res, 403, 'You are not registered on this campus.');
    }

    // Status check — never reveal suspended vs non-existent
    if (parent.status !== 'active') {
      return sendError(res, 403, 'Your account is not active. Please contact support.');
    }

    // Archived accounts cannot log in
    if (parent.isArchived) {
      return sendError(res, 403, 'Your account is not active. Please contact support.');
    }

    // Build JWT
    const token = jwt.sign(
      buildTokenPayload(parent),
      JWT_SECRET,
      { expiresIn: '7d', issuer: 'school-management-app' }
    );

    // Update lastLogin — fire-and-forget (must not block the response)
    Parent.findByIdAndUpdate(parent._id, { lastLogin: new Date() }).exec().catch(() => {});

    return sendSuccess(res, 200, 'Login successful.', {
      token,
      user: buildUserResponse(parent),
    });

  } catch (error) {
    console.error('❌ loginParent error:', error);
    return sendError(res, 500, 'Internal server error during login.');
  }
};

// ── GET OWN PROFILE ───────────────────────────────────────────────────────────

/**
 * Return the authenticated parent's own profile, with children populated.
 *
 * @route  GET /api/parents/me
 * @access PARENT
 */
const getMe = async (req, res) => {
  try {
    const parent = await Parent.findById(req.user.id)
      .select('-password -__v -notes') // notes are admin-only
      .populate('schoolCampus', 'campus_name location')
      .populate('children', 'firstName lastName profileImage studentClass status')
      .lean({ virtuals: true });

    if (!parent) {
      return sendNotFound(res, 'Parent');
    }

    return sendSuccess(res, 200, 'Profile retrieved successfully.', parent);

  } catch (error) {
    console.error('❌ getMe error:', error);
    return sendError(res, 500, 'Failed to retrieve profile.');
  }
};

// ── UPDATE OWN PASSWORD ───────────────────────────────────────────────────────

/**
 * Change the authenticated parent's own password.
 * Requires currentPassword verification before setting the new one.
 *
 * Body: { currentPassword, newPassword }
 *
 * @route  PUT /api/parents/me/password
 * @access PARENT
 */
const updatePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return sendError(res, 400, 'currentPassword and newPassword are required.');
    }

    const strength = validatePasswordStrength(newPassword);
    if (!strength.valid) {
      return sendError(res, 400, 'Password does not meet requirements.', { errors: strength.errors });
    }

    // Fetch parent with password field
    const parent = await Parent.findById(req.user.id).select('+password');
    if (!parent) {
      return sendNotFound(res, 'Parent');
    }

    // Verify current password
    const isMatch = await bcrypt.compare(currentPassword, parent.password);
    if (!isMatch) {
      return sendError(res, 401, 'Current password is incorrect.');
    }

    if (currentPassword === newPassword) {
      return sendError(res, 400, 'New password must differ from the current password.');
    }

    // Hash + save (pre-save hook will re-hash; bypass by setting directly)
    const salt    = await bcrypt.genSalt(SALT_ROUNDS);
    parent.password = await bcrypt.hash(newPassword, salt);
    // Mark as not modified so pre-save doesn't double-hash
    parent.$ignore('password');
    await Parent.findByIdAndUpdate(parent._id, { password: parent.password });

    return sendSuccess(res, 200, 'Password updated successfully.');

  } catch (error) {
    console.error('❌ updatePassword error:', error);
    return sendError(res, 500, 'Failed to update password.');
  }
};

// ── UPDATE OWN PROFILE ────────────────────────────────────────────────────────

/**
 * Update the authenticated parent's own profile.
 * Only allows: phone, address, preferredLanguage, notificationPrefs.
 * All other fields are ignored (cannot self-modify schoolCampus, children, status, etc.)
 *
 * @route  PUT /api/parents/me/profile
 * @access PARENT
 */
const updateProfile = async (req, res) => {
  try {
    const { phone, address, preferredLanguage, notificationPrefs } = req.body;

    // Build a whitelist of allowed updates
    const updates = {};
    if (phone              !== undefined) updates.phone              = phone;
    if (address            !== undefined) updates.address            = address;
    if (preferredLanguage  !== undefined) updates.preferredLanguage  = preferredLanguage;
    if (notificationPrefs  !== undefined) updates.notificationPrefs  = notificationPrefs;

    if (Object.keys(updates).length === 0) {
      return sendError(res, 400, 'No updatable fields provided. Allowed: phone, address, preferredLanguage, notificationPrefs.');
    }

    const parent = await Parent.findByIdAndUpdate(
      req.user.id,
      { $set: updates },
      { new: true, runValidators: true }
    )
      .select('-password -__v -notes')
      .populate('schoolCampus', 'campus_name')
      .lean({ virtuals: true });

    if (!parent) {
      return sendNotFound(res, 'Parent');
    }

    return sendSuccess(res, 200, 'Profile updated successfully.', parent);

  } catch (error) {
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map((e) => ({
        field:   e.path,
        message: e.message,
      }));
      return sendError(res, 400, 'Validation failed.', errors);
    }
    console.error('❌ updateProfile error:', error);
    return sendError(res, 500, 'Failed to update profile.');
  }
};

// ── UPLOAD PROFILE IMAGE ──────────────────────────────────────────────────────

/**
 * Store the Cloudinary URL returned after a direct upload.
 *
 * Flow:
 *   1. Frontend calls GET /api/campus/:campusId/upload-signature → gets signed URL
 *   2. Frontend uploads directly to Cloudinary
 *   3. Frontend sends the resulting URL here
 *
 * Body: { profileImageUrl: string }
 *
 * @route  POST /api/parents/me/profile-image
 * @access PARENT
 */
const uploadProfileImage = async (req, res) => {
  try {
    const { profileImageUrl } = req.body;

    if (!profileImageUrl || typeof profileImageUrl !== 'string' || !profileImageUrl.trim()) {
      return sendError(res, 400, 'profileImageUrl is required.');
    }

    const parent = await Parent.findByIdAndUpdate(
      req.user.id,
      { $set: { profileImage: profileImageUrl.trim() } },
      { new: true }
    )
      .select('_id firstName lastName profileImage')
      .lean({ virtuals: true });

    if (!parent) {
      return sendNotFound(res, 'Parent');
    }

    return sendSuccess(res, 200, 'Profile image updated successfully.', {
      profileImage: parent.profileImage,
    });

  } catch (error) {
    console.error('❌ uploadProfileImage error:', error);
    return sendError(res, 500, 'Failed to update profile image.');
  }
};

// ── EXPORTS ───────────────────────────────────────────────────────────────────

module.exports = {
  loginParent,
  getMe,
  updatePassword,
  updateProfile,
  uploadProfileImage,
};
