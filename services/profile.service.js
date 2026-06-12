'use strict';

/**
 * @file profile.service.js
 * @description Shared self-service profile handlers reused by Student, Teacher, Admin.
 *
 * Each function receives the Mongoose Model, a MongoDB filter (the "who"),
 * and the raw Express req/res objects.  Controllers call these and never
 * duplicate the bcrypt / whitelist logic themselves.
 *
 * Password contract:
 *  - We hash manually with bcrypt.hash and call findByIdAndUpdate so that
 *    the Model's pre-save hook (which also hashes) is never triggered.
 *    This prevents double-hashing.
 *
 * Campus isolation:
 *  - Callers whose JWT contains campusId must pass a filter like
 *    { _id: req.user.id, schoolCampus: campusId }.
 *  - Callers without campusId (Admin, Director) pass { _id: req.user.id }.
 */

const bcrypt = require('bcrypt');
const crypto = require('crypto');

const {
  sendSuccess,
  sendError,
  sendNotFound,
} = require('../shared/utils/response-helpers');
const { validatePasswordStrength } = require('../shared/utils/validation-helpers');

const SALT_ROUNDS = 12;

// ── GET OWN PROFILE ───────────────────────────────────────────────────────────

/**
 * Returns the authenticated user's own document.
 *
 * @param {Model}    Model        - Mongoose model
 * @param {Object}   filter       - MongoDB filter, e.g. { _id, schoolCampus }
 * @param {Object}   [populateOpts] - optional populate config array
 * @param {string[]} [extraSelect]  - fields to add with select() in addition to
 *                                   the default "-password -__v"
 */
const getMe = async (res, Model, filter, populateOpts = [], extraSelect = []) => {
  try {
    const base = '-password -__v';
    const select = extraSelect.length ? `${base} ${extraSelect.join(' ')}` : base;

    let query = Model.findOne(filter).select(select);
    for (const p of populateOpts) {
      query = query.populate(p.path, p.select);
    }
    const doc = await query.lean({ virtuals: true });

    if (!doc) return sendNotFound(res, Model.modelName);
    return sendSuccess(res, 200, 'Profile retrieved.', doc);
  } catch (err) {
    console.error(`❌ [profile.service] getMe ${Model.modelName}:`, err.message);
    return sendError(res, 500, 'Failed to retrieve profile.');
  }
};

// ── UPDATE OWN PROFILE ────────────────────────────────────────────────────────

/**
 * Updates only the fields present in `allowedFields` (whitelist).
 * Fields absent from the request body are silently skipped.
 *
 * @param {Model}    Model         - Mongoose model
 * @param {Object}   filter        - MongoDB filter
 * @param {string[]} allowedFields - fields the user may self-modify
 * @param {Object}   body          - req.body
 */
const updateProfile = async (res, Model, filter, allowedFields, body) => {
  try {
    const updates = {};
    for (const key of allowedFields) {
      if (body[key] !== undefined) updates[key] = body[key];
    }

    if (Object.keys(updates).length === 0) {
      return sendError(
        res, 400,
        `No updatable fields provided. Allowed: ${allowedFields.join(', ')}.`
      );
    }

    const doc = await Model.findOneAndUpdate(
      filter,
      { $set: updates },
      { new: true, runValidators: true }
    ).select('-password -__v').lean({ virtuals: true });

    if (!doc) return sendNotFound(res, Model.modelName);
    return sendSuccess(res, 200, 'Profile updated.', doc);
  } catch (err) {
    if (err.name === 'ValidationError') {
      const errors = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
      return sendError(res, 400, 'Validation failed.', errors);
    }
    console.error(`❌ [profile.service] updateProfile ${Model.modelName}:`, err.message);
    return sendError(res, 500, 'Failed to update profile.');
  }
};

// ── CHANGE OWN PASSWORD ───────────────────────────────────────────────────────

/**
 * Verifies currentPassword against the stored hash, then sets newPassword.
 * Hashes manually (bypasses pre-save) to avoid double-hashing.
 *
 * @param {Model}    Model          - Mongoose model (must have comparePassword method
 *                                   OR store a bcrypt hash in password field)
 * @param {Object}   filter         - MongoDB filter
 * @param {Object}   body           - { currentPassword, newPassword }
 */
const changePassword = async (res, Model, filter, body) => {
  try {
    const { currentPassword, newPassword } = body;

    if (!currentPassword || !newPassword) {
      return sendError(res, 400, 'currentPassword and newPassword are required.');
    }
    if (currentPassword === newPassword) {
      return sendError(res, 400, 'New password must differ from the current password.');
    }

    const pwCheck = validatePasswordStrength(newPassword);
    if (!pwCheck.valid) return sendError(res, 400, pwCheck.errors[0]);

    const doc = await Model.findOne(filter).select('+password');
    if (!doc) return sendNotFound(res, Model.modelName);

    // Support both comparePassword() instance method and plain bcrypt check
    const isMatch = doc.comparePassword
      ? await doc.comparePassword(currentPassword)
      : await bcrypt.compare(currentPassword, doc.password);

    if (!isMatch) return sendError(res, 401, 'Current password is incorrect.');

    const hashed = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await Model.findByIdAndUpdate(doc._id, { password: hashed });

    return sendSuccess(res, 200, 'Password updated successfully.');
  } catch (err) {
    console.error(`❌ [profile.service] changePassword ${Model.modelName}:`, err.message);
    return sendError(res, 500, 'Failed to update password.');
  }
};

// ── UPLOAD PROFILE IMAGE ──────────────────────────────────────────────────────

/**
 * Stores the Cloudinary URL returned after a client-side direct upload.
 * Body: { profileImageUrl: string }
 *
 * @param {Model}  Model  - Mongoose model
 * @param {Object} filter - MongoDB filter
 * @param {Object} body   - req.body
 */
const uploadProfileImage = async (res, Model, filter, body) => {
  try {
    const { profileImageUrl } = body;

    if (!profileImageUrl?.trim()) {
      return sendError(res, 400, 'profileImageUrl is required.');
    }

    let parsed;
    try { parsed = new URL(profileImageUrl.trim()); } catch {
      return sendError(res, 400, 'profileImageUrl must be a valid URL.');
    }
    if (parsed.protocol !== 'https:') {
      return sendError(res, 400, 'profileImageUrl must use HTTPS.');
    }

    const doc = await Model.findOneAndUpdate(
      filter,
      { $set: { profileImage: profileImageUrl.trim() } },
      { new: true }
    ).select('_id firstName lastName admin_name profileImage').lean({ virtuals: true });

    if (!doc) return sendNotFound(res, Model.modelName);
    return sendSuccess(res, 200, 'Profile image updated.', { profileImage: doc.profileImage });
  } catch (err) {
    console.error(`❌ [profile.service] uploadProfileImage ${Model.modelName}:`, err.message);
    return sendError(res, 500, 'Failed to update profile image.');
  }
};

// ── UPDATE NOTIFICATION PREFERENCES ──────────────────────────────────────────

/**
 * Updates notificationPrefs sub-document.
 * Body: { email?: boolean, sms?: boolean, push?: boolean }
 *
 * @param {Model}  Model  - Mongoose model
 * @param {Object} filter - MongoDB filter
 * @param {Object} body   - req.body
 */
const updateNotifications = async (res, Model, filter, body) => {
  try {
    const { email, sms, push } = body;

    const updates = {};
    if (email !== undefined) updates['notificationPrefs.email'] = Boolean(email);
    if (sms   !== undefined) updates['notificationPrefs.sms']   = Boolean(sms);
    if (push  !== undefined) updates['notificationPrefs.push']  = Boolean(push);

    if (Object.keys(updates).length === 0) {
      return sendError(res, 400, 'Provide at least one preference: email, sms, push.');
    }

    const doc = await Model.findOneAndUpdate(
      filter,
      { $set: updates },
      { new: true }
    ).select('notificationPrefs').lean();

    if (!doc) return sendNotFound(res, Model.modelName);
    return sendSuccess(res, 200, 'Notification preferences updated.', doc.notificationPrefs);
  } catch (err) {
    console.error(`❌ [profile.service] updateNotifications ${Model.modelName}:`, err.message);
    return sendError(res, 500, 'Failed to update notification preferences.');
  }
};

// ── CLOUDINARY UPLOAD SIGNATURE ───────────────────────────────────────────────

/**
 * Generates a short-lived Cloudinary signed upload token for profile images.
 * The browser uses this to upload directly to Cloudinary (no file goes through
 * our server), then sends back only the resulting secure_url.
 *
 * @route  GET /{role}/me/upload-signature
 */
const getUploadSignature = (res) => {
  try {
    const timestamp = Math.round(Date.now() / 1000);
    const folder    = 'backend/profiles';

    const signature = crypto
      .createHash('sha1')
      .update(`folder=${folder}&timestamp=${timestamp}${process.env.CLOUDINARY_API_SECRET}`)
      .digest('hex');

    return sendSuccess(res, 200, 'Upload signature generated.', {
      signature,
      timestamp,
      folder,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey:    process.env.CLOUDINARY_API_KEY,
    });
  } catch (err) {
    console.error('❌ [profile.service] getUploadSignature:', err.message);
    return sendError(res, 500, 'Failed to generate upload signature.');
  }
};

module.exports = {
  getMe,
  updateProfile,
  changePassword,
  uploadProfileImage,
  updateNotifications,
  getUploadSignature,
};
