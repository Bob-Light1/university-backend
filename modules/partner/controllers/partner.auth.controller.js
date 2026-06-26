'use strict';

/**
 * @file partner_auth_controller.js
 * @description Auth endpoints for the PARTNER role.
 *
 * Routes:
 *  POST  /api/partners/auth/register        → register        (MGR/DIR/ADMIN)
 *  POST  /api/partners/auth/login           → login           (PUBLIC)
 *  POST  /api/partners/auth/forgot-password → forgotPassword  (PUBLIC)
 *  POST  /api/partners/auth/reset-password/:token → resetPassword (PUBLIC)
 *  GET   /api/partners/me                   → getMe           (PARTNER)
 *  PUT   /api/partners/me/profile           → updateMyProfile (PARTNER)
 *  PUT   /api/partners/me/password          → changeMyPassword (PARTNER)
 *  POST  /api/partners/me/profile-image     → uploadProfileImage (PARTNER)
 *
 * Invariants:
 * • campusId always from the JWT — never from URL params.
 * • Referral link & QR are derived from partnerCode (see shared/utils/referral);
 *   the QR is generated on the fly, never stored on disk.
 * • Password: bcrypt 12 rounds via pre-save hook (register) or manually (changeMyPassword).
 * • JWT payload: { id, role:'PARTNER', campusId, partnerCode, partnerType }
 */

const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const mongoose = require('mongoose');

const partnerRepo = require('../partner.repository');
const {
  sendSuccess,
  sendError,
  sendCreated,
  sendNotFound,
} = require('../../../shared/utils/response-helpers');
const { isValidObjectId, validatePasswordStrength } = require('../../../shared/utils/validation-helpers');
const { buildReferralUrl } = require('../../../shared/utils/referral');
const { getLoginPrefs } = require('../../settings').service;

const SALT_ROUNDS = 12;
const JWT_SECRET  = process.env.JWT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// ── HELPERS ───────────────────────────────────────────────────────────────────

const buildTokenPayload = (partner) => ({
  id:          partner._id.toString(),
  role:        'PARTNER',
  campusId:    partner.schoolCampus?.toString?.() ?? partner.schoolCampus,
  partnerCode: partner.partnerCode,
  partnerType: partner.partnerType,
});

const buildPartnerResponse = (partner) => {
  const obj = partner.toObject ? partner.toObject({ virtuals: true }) : { ...partner };
  delete obj.password;
  delete obj.__v;
  // The model's `role` field defaults to null; we force 'PARTNER' so that
  // the front-end (ProtectedRoute) resolves the authorizations correctly.
  obj.role = 'PARTNER';
  return obj;
};

const isGlobalRole = (role) => role === 'ADMIN' || role === 'DIRECTOR';

/**
 * Normalizes a convention sub-document coming from the client: drops empty-string
 * fields so optional Date / Number / enum fields don't trip Mongoose casting or
 * enum validation. Returns null when nothing meaningful is provided.
 */
const normalizeConvention = (conv) => {
  if (!conv || typeof conv !== 'object') return null;
  const out = {};
  for (const key of ['startDate', 'endDate', 'commissionType', 'currency', 'status', 'notes', 'documentUrl']) {
    if (conv[key] !== undefined && conv[key] !== null && conv[key] !== '') out[key] = conv[key];
  }
  if (conv.commissionValue !== undefined && conv.commissionValue !== null && conv.commissionValue !== '') {
    out.commissionValue = conv.commissionValue;
  }
  return Object.keys(out).length ? out : null;
};

/**
 * Normalizes a per-partner commission override. Returns null when no ruleType is
 * selected (the engine then falls back to the campus-level config). Keeps only
 * the amount relevant to the chosen rule so a stale percentage/fixedAmount from a
 * previous selection is never persisted.
 */
const normalizeCommissionConfig = (cfg) => {
  if (!cfg || typeof cfg !== 'object' || !cfg.ruleType) return null;
  if (!['FIXED', 'PERCENTAGE'].includes(cfg.ruleType)) return null;
  const out = { ruleType: cfg.ruleType };
  if (cfg.ruleType === 'FIXED') {
    out.fixedAmount = Number(cfg.fixedAmount) || 0;
  } else {
    out.percentage = Number(cfg.percentage) || 0;
  }
  if (cfg.currency) out.currency = cfg.currency;
  return out;
};

// ── REGISTER ──────────────────────────────────────────────────────────────────

/**
 * Creates a new partner account and generates partnerCode + QR.
 * Called by CAMPUS_MANAGER / ADMIN / DIRECTOR.
 *
 * @route  POST /api/partners/auth/register
 * @access CAMPUS_MANAGER, ADMIN, DIRECTOR
 */
const register = async (req, res) => {
  try {
    if (!JWT_SECRET) return sendError(res, 500, 'Server configuration error.');

    const {
      firstName, lastName, email, phone, gender,
      password, organization, bio,
      partnerType, institutionType, commercialType, channelType,
      tier, contacts, convention, commissionConfig, socialLinks,
      subjectId, country,
      // ADMIN/DIRECTOR can target a specific campus
      schoolCampus: bodyCampusId,
    } = req.body;

    // Validate required fields
    if (!firstName?.trim()) return sendError(res, 400, 'firstName is required.');
    if (!lastName?.trim())  return sendError(res, 400, 'lastName is required.');
    if (!email?.trim())     return sendError(res, 400, 'email is required.');
    if (!password)          return sendError(res, 400, 'password is required.');
    const pwCheck = validatePasswordStrength(password);
    if (!pwCheck.valid)     return sendError(res, 400, pwCheck.errors[0]);
    if (!partnerType)       return sendError(res, 400, 'partnerType is required.');

    // Resolve the campus
    let campusId;
    if (isGlobalRole(req.user.role)) {
      if (!bodyCampusId) return sendError(res, 400, 'schoolCampus is required for ADMIN/DIRECTOR.');
      if (!isValidObjectId(bodyCampusId)) return sendError(res, 400, 'Invalid schoolCampus.');
      campusId = new mongoose.Types.ObjectId(bodyCampusId);
    } else {
      if (!req.user.campusId) return sendError(res, 403, 'Campus information not found in your account.');
      campusId = new mongoose.Types.ObjectId(req.user.campusId);
    }

    // Email uniqueness
    const existing = await partnerRepo.findPartnerByEmail(email.toLowerCase().trim());
    if (existing) return sendError(res, 409, 'A partner with this email already exists.');

    // Generate partnerCode
    const year = new Date().getFullYear();
    const partnerCode = await partnerRepo.generatePartnerCode(
      lastName.trim(),
      firstName.trim(),
      country || 'CMR',
      year
    );

    // referralLink and the QR are both derived from partnerCode at read time
    // (virtual + GET /partners/public/qr/:code) — nothing is generated or stored here.

    // Create the partner (the pre-save hook hashes the password)
    const partner = await partnerRepo.createPartner({
      schoolCampus:     campusId,
      firstName:        firstName.trim(),
      lastName:         lastName.trim(),
      email:            email.toLowerCase().trim(),
      phone:            phone || null,
      gender:           gender || null,
      password,
      organization:     organization || null,
      bio:              bio || null,
      partnerType,
      institutionType:  institutionType || null,
      commercialType:   commercialType  || null,
      channelType:      channelType     || null,
      tier:             tier            || 'bronze',
      contacts:         contacts        || [],
      convention:       normalizeConvention(convention),
      commissionConfig: normalizeCommissionConfig(commissionConfig),
      socialLinks:      socialLinks     || null,
      partnerCode,
      createdBy:        req.user.id,
      status:           'active',
    });

    const safePartner = buildPartnerResponse(partner);
    return sendCreated(res, 'Partner account created successfully.', safePartner);

  } catch (error) {
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern || {})[0] || 'field';
      return sendError(res, 409, `${field} already exists.`);
    }
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map((e) => ({ field: e.path, message: e.message }));
      return sendError(res, 400, 'Validation failed.', errors);
    }
    console.error('❌ register partner error:', error);
    return sendError(res, 500, 'Failed to create partner account.');
  }
};

// ── LOGIN ─────────────────────────────────────────────────────────────────────

/**
 * Partner login — returns a JWT.
 *
 * @route  POST /api/partners/auth/login
 * @access PUBLIC
 */
const login = async (req, res) => {
  try {
    if (!JWT_SECRET) return sendError(res, 500, 'Server configuration error.');

    const { email, password } = req.body;

    if (!email || !password) return sendError(res, 400, 'Email and password are required.');

    const partner = await partnerRepo.findPartnerByEmailWithPassword(email.toLowerCase().trim());
    if (!partner) return sendError(res, 401, 'Invalid credentials.');

    const isMatch = await partner.comparePassword(password);
    if (!isMatch) return sendError(res, 401, 'Invalid credentials.');

    if (partner.status === 'archived' || partner.status === 'suspended') {
      return sendError(res, 403, 'Your account is not active. Please contact support.');
    }

    const token = jwt.sign(
      buildTokenPayload(partner),
      JWT_SECRET,
      { expiresIn: '7d', issuer: 'school-management-app' }
    );

    // Fire-and-forget: lastLoginAt + lastActivityAt
    partnerRepo.touchLoginActivity(partner._id).catch(() => {});

    const safePartner = buildPartnerResponse(partner);
    const prefs = await getLoginPrefs(partner._id, 'PARTNER', partner.schoolCampus ?? null);
    return sendSuccess(res, 200, 'Login successful.', { token, user: { ...safePartner, ...prefs } });

  } catch (error) {
    console.error('❌ login partner error:', error);
    return sendError(res, 500, 'Internal server error during login.');
  }
};

// ── FORGOT PASSWORD ───────────────────────────────────────────────────────────

/**
 * Generates a signed password-reset token (1h).
 * In P2: link returned in the response + WhatsApp dispatch (stub).
 * In P3: real WhatsApp via the selected provider.
 *
 * @route  POST /api/partners/auth/forgot-password
 * @access PUBLIC
 */
const forgotPassword = async (req, res) => {
  try {
    if (!JWT_SECRET) return sendError(res, 500, 'Server configuration error.');

    const { email } = req.body;
    if (!email?.trim()) return sendError(res, 400, 'email is required.');

    const partner = await partnerRepo.findPartnerByEmailWithPasswordLean(email.toLowerCase().trim());

    // Always respond 200 so as not to reveal whether the email exists
    if (!partner) {
      return sendSuccess(res, 200, 'If this email is registered, a reset link has been sent.');
    }

    // The current password hash acts as a nonce — invalidates the token as soon as the password changes
    const resetToken = jwt.sign(
      { id: partner._id.toString(), purpose: 'pwd-reset', nonce: partner.password?.slice(-8) },
      JWT_SECRET,
      { expiresIn: '1h', issuer: 'school-management-app' }
    );

    const resetLink = `${FRONTEND_URL}/partner/reset-password?token=${resetToken}`;

    // TODO P2: Send resetLink via WhatsApp Business API (provider to be selected)
    console.info(`[PARTNER RESET] Reset link for ${partner.email}: ${resetLink}`);

    return sendSuccess(res, 200, 'If this email is registered, a reset link has been sent.', {
      // Exposed only in development
      ...(process.env.NODE_ENV !== 'production' && { resetLink }),
    });

  } catch (error) {
    console.error('❌ forgotPassword partner error:', error);
    return sendError(res, 500, 'Failed to process password reset request.');
  }
};

// ── RESET PASSWORD ────────────────────────────────────────────────────────────

/**
 * Validates the signed token and updates the password.
 *
 * @route  POST /api/partners/auth/reset-password/:token
 * @access PUBLIC
 */
const resetPassword = async (req, res) => {
  try {
    if (!JWT_SECRET) return sendError(res, 500, 'Server configuration error.');

    const { token } = req.params;
    const { newPassword } = req.body;

    if (!token)       return sendError(res, 400, 'Reset token is required.');
    if (!newPassword) return sendError(res, 400, 'newPassword is required.');
    const pwCheck = validatePasswordStrength(newPassword);
    if (!pwCheck.valid) return sendError(res, 400, pwCheck.errors[0]);

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET, { issuer: 'school-management-app' });
    } catch {
      return sendError(res, 400, 'Invalid or expired reset token.');
    }

    if (decoded.purpose !== 'pwd-reset') return sendError(res, 400, 'Invalid reset token.');

    const partner = await partnerRepo.findPartnerByIdWithPassword(decoded.id);
    if (!partner) return sendError(res, 404, 'Partner not found.');

    // Verify the nonce matches — invalid if the password has already been changed
    if (partner.password?.slice(-8) !== decoded.nonce) {
      return sendError(res, 400, 'Reset token has already been used.');
    }

    const salt = await bcrypt.genSalt(SALT_ROUNDS);
    const hashed = await bcrypt.hash(newPassword, salt);

    await partnerRepo.setPartnerPassword(partner._id, hashed);

    return sendSuccess(res, 200, 'Password reset successfully.');

  } catch (error) {
    console.error('❌ resetPassword partner error:', error);
    return sendError(res, 500, 'Failed to reset password.');
  }
};

// ── GET OWN PROFILE ───────────────────────────────────────────────────────────

/**
 * @route  GET /api/partners/me
 * @access PARTNER
 */
const getMe = async (req, res) => {
  try {
    const partner = await partnerRepo.findOwnProfile(
      req.user.id,
      new mongoose.Types.ObjectId(req.user.campusId)
    );

    if (!partner) return sendNotFound(res, 'Partner');

    partner.role = 'PARTNER';
    return sendSuccess(res, 200, 'Profile retrieved.', partner);

  } catch (error) {
    console.error('❌ getMe partner error:', error);
    return sendError(res, 500, 'Failed to retrieve profile.');
  }
};

// ── UPDATE OWN PROFILE ────────────────────────────────────────────────────────

/**
 * Updates the fields editable by the partner themselves.
 * Allowed fields: bio, phone, socialLinks, contacts, organization.
 * Protected fields (partnerCode, schoolCampus, etc.): silently ignored.
 *
 * @route  PUT /api/partners/me/profile
 * @access PARTNER
 */
const updateMyProfile = async (req, res) => {
  try {
    const allowed = ['bio', 'phone', 'socialLinks', 'contacts', 'organization', 'gender'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        // Normalize empty strings to null so optional enum fields (e.g. gender)
        // don't trip Mongoose enum validation with '' (which is not a valid value).
        updates[key] = req.body[key] === '' ? null : req.body[key];
      }
    }

    if (Object.keys(updates).length === 0) {
      return sendError(res, 400, `No updatable fields provided. Allowed: ${allowed.join(', ')}.`);
    }

    const partner = await partnerRepo.updateOwnProfile(
      req.user.id,
      new mongoose.Types.ObjectId(req.user.campusId),
      updates
    );

    if (!partner) return sendNotFound(res, 'Partner');

    return sendSuccess(res, 200, 'Profile updated.', partner);

  } catch (error) {
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map((e) => ({ field: e.path, message: e.message }));
      return sendError(res, 400, 'Validation failed.', errors);
    }
    console.error('❌ updateMyProfile partner error:', error);
    return sendError(res, 500, 'Failed to update profile.');
  }
};

// ── CHANGE OWN PASSWORD ───────────────────────────────────────────────────────

/**
 * @route  PUT /api/partners/me/password
 * @access PARTNER
 */
const changeMyPassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return sendError(res, 400, 'currentPassword and newPassword are required.');
    }
    const pwCheck = validatePasswordStrength(newPassword);
    if (!pwCheck.valid) {
      return sendError(res, 400, pwCheck.errors[0]);
    }
    if (currentPassword === newPassword) {
      return sendError(res, 400, 'New password must differ from the current password.');
    }

    const partner = await partnerRepo.findOwnProfileWithPassword(
      req.user.id,
      new mongoose.Types.ObjectId(req.user.campusId)
    );

    if (!partner) return sendNotFound(res, 'Partner');

    const isMatch = await partner.comparePassword(currentPassword);
    if (!isMatch) return sendError(res, 401, 'Current password is incorrect.');

    // Hash manually to bypass the pre-save hook (avoids double-hashing)
    const salt   = await bcrypt.genSalt(SALT_ROUNDS);
    const hashed = await bcrypt.hash(newPassword, salt);

    await partnerRepo.setPartnerPassword(partner._id, hashed);

    return sendSuccess(res, 200, 'Password updated successfully.');

  } catch (error) {
    console.error('❌ changeMyPassword partner error:', error);
    return sendError(res, 500, 'Failed to update password.');
  }
};

// ── UPLOAD PROFILE IMAGE ──────────────────────────────────────────────────────

/**
 * Stores the Cloudinary URL returned after direct upload.
 * Body: { profileImageUrl: string }
 *
 * @route  POST /api/partners/me/profile-image
 * @access PARTNER
 */
const uploadProfileImage = async (req, res) => {
  try {
    const { profileImageUrl } = req.body;

    if (!profileImageUrl?.trim()) {
      return sendError(res, 400, 'profileImageUrl is required.');
    }

    const partner = await partnerRepo.updateOwnProfileImage(
      req.user.id,
      new mongoose.Types.ObjectId(req.user.campusId),
      profileImageUrl.trim()
    );

    if (!partner) return sendNotFound(res, 'Partner');

    return sendSuccess(res, 200, 'Profile image updated.', { profileImage: partner.profileImage });

  } catch (error) {
    console.error('❌ uploadProfileImage partner error:', error);
    return sendError(res, 500, 'Failed to update profile image.');
  }
};

// ── EXPORTS ───────────────────────────────────────────────────────────────────

module.exports = {
  register,
  login,
  forgotPassword,
  resetPassword,
  getMe,
  updateMyProfile,
  changeMyPassword,
  uploadProfileImage,
};
