'use strict';

/**
 * @file admin.controller.js
 * @description Controllers for platform-level Admin and Director accounts.
 *
 * Endpoints:
 *  POST /api/admin/login           → loginAdmin
 *  POST /api/admin/create          → createAdmin
 *  GET  /api/admin/me              → getMe
 *  PUT  /api/admin/me/password     → updatePassword
 *
 * Response shape (all endpoints):
 *  All responses use the centralised sendSuccess / sendError helpers so that
 *  AuthContext.jsx can always destructure responseData.data.token and
 *  responseData.data.user without special-casing this controller.
 *
 * Security notes:
 *  - Password is hashed with bcrypt (SALT_ROUNDS = 12).
 *  - JWT payload is minimal — no sensitive fields.
 *  - lastLogin is updated asynchronously (fire-and-forget) to avoid
 *    blocking the login response.
 *  - Generic "Invalid credentials" message prevents user-enumeration.
 *  - req.body is used directly (no formidable) — the router must apply
 *    express.json() before these handlers.
 */

require('dotenv').config();

const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');

const Admin = require('../models/admin.model');

const {
  sendSuccess,
  sendCreated,
  sendError,
  sendNotFound,
  sendConflict,
  asyncHandler,
  handleDuplicateKeyError,
} = require('../utils/responseHelpers');

const { isValidEmail } = require('../utils/validationHelpers');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const JWT_SECRET   = process.env.JWT_SECRET;
const SALT_ROUNDS  = 12; // Increased from 10 for better security
const TOKEN_EXPIRY = '7d';
const JWT_ISSUER   = 'school-management-app';

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Build the JWT payload for an admin / director account.
 * Keep the payload minimal — never include sensitive fields.
 * @param {Object} admin - Mongoose document
 * @returns {Object}
 */
const buildTokenPayload = (admin) => ({
  id:         admin._id,
  adminId:    admin._id,
  admin_name: admin.admin_name,
  role:       admin.role,   // 'ADMIN' | 'DIRECTOR'
});

/**
 * Build the public user object returned in every login response.
 * @param {Object} admin - Mongoose document
 * @returns {Object}
 */
const buildUserResponse = (admin) => ({
  id:           admin._id,
  admin_name:   admin.admin_name,
  email:        admin.email,
  role:         admin.role,
  status:       admin.status,
  profileImage: admin.profileImage ?? null,
  lastLogin:    admin.lastLogin ?? null,
});

// ─── LOGIN ────────────────────────────────────────────────────────────────────

/**
 * POST /api/admin/login
 * Authenticate an Admin or Director.
 *
 * Body: { email: string, password: string }
 *
 * Success response (200):
 *  { success: true, data: { token, user } }
 *
 * The response shape matches all other login endpoints (campus, teacher,
 * student) so that AuthContext.jsx can destructure data.token / data.user
 * uniformly.
 */
const loginAdmin = asyncHandler(async (req, res) => {
  const { email, password } = req.body ?? {};

  // ── Input validation ────────────────────────────────────────────────────────
  if (!email || !password) {
    return sendError(res, 400, 'Email and password are required.');
  }

  if (!isValidEmail(email)) {
    return sendError(res, 400, 'Invalid email format.');
  }

  if (!JWT_SECRET) {
    console.error('❌ JWT_SECRET is not defined in environment variables');
    return sendError(res, 500, 'Server configuration error.');
  }

  // ── Find admin (include password for comparison) ────────────────────────────
  const admin = await Admin.findOne({ email: email.toLowerCase().trim() })
    .select('+password');

  // Generic message — prevents user-enumeration attack
  if (!admin) {
    return sendError(res, 401, 'Invalid email or password.');
  }

  // ── Password check ──────────────────────────────────────────────────────────
  const isPasswordValid = await bcrypt.compare(password, admin.password);
  if (!isPasswordValid) {
    return sendError(res, 401, 'Invalid email or password.');
  }

  // ── Account status check ────────────────────────────────────────────────────
  if (admin.status !== 'active') {
    return sendError(
      res,
      403,
      'This account is inactive or suspended. Please contact support.',
    );
  }

  // ── Issue JWT ───────────────────────────────────────────────────────────────
  const token = jwt.sign(
    buildTokenPayload(admin),
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY, issuer: JWT_ISSUER },
  );

  // ── Update lastLogin (fire-and-forget — does not block the response) ────────
  Admin.updateOne({ _id: admin._id }, { $set: { lastLogin: new Date() } })
    .catch((err) => console.error('[adminController] lastLogin update failed:', err.message));

  return sendSuccess(res, 200, 'Login successful.', {
    token,
    user: buildUserResponse(admin),
  });
});

// ─── CREATE ───────────────────────────────────────────────────────────────────

/**
 * POST /api/admin/create
 * Create a new Admin or Director account.
 * Protected by strictLimiter (3 attempts / hour) in the router.
 *
 * Body: { admin_name, email, password, role? }
 *   role defaults to 'ADMIN'; pass 'DIRECTOR' to create a director.
 *
 * Caller must be authenticated as ADMIN (enforced in the router).
 */
const createAdmin = asyncHandler(async (req, res) => {
  const { admin_name, email, password, role = 'ADMIN' } = req.body ?? {};

  // ── Bootstrap / auth guard ──────────────────────────────────────────────────
  // If at least one admin already exists, the caller must be an authenticated ADMIN.
  const adminCount = await Admin.countDocuments();
  if (adminCount > 0) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return sendError(res, 401, 'Authentication required to create an admin account.');
    }
    let payload;
    try {
      payload = jwt.verify(authHeader.slice(7), JWT_SECRET, { issuer: JWT_ISSUER });
    } catch {
      return sendError(res, 401, 'Invalid or expired token.');
    }
    if (payload.role !== 'ADMIN') {
      return sendError(res, 403, 'Only an ADMIN can create new accounts.');
    }
  }

  // ── Input validation ────────────────────────────────────────────────────────
  if (!admin_name || !email || !password) {
    return sendError(res, 400, 'admin_name, email and password are required.');
  }

  if (admin_name.trim().length < 2 || admin_name.trim().length > 100) {
    return sendError(res, 400, 'admin_name must be between 2 and 100 characters.');
  }

  if (!isValidEmail(email)) {
    return sendError(res, 400, 'Invalid email format.');
  }

  if (!['ADMIN', 'DIRECTOR'].includes(role)) {
    return sendError(res, 400, 'role must be ADMIN or DIRECTOR.');
  }

  // ── Password strength ───────────────────────────────────────────────────────
  if (password.length < 8) {
    return sendError(res, 400, 'Password must be at least 8 characters long.');
  }
  if (!/[A-Z]/.test(password)) {
    return sendError(res, 400, 'Password must contain at least one uppercase letter.');
  }
  if (!/[0-9]/.test(password)) {
    return sendError(res, 400, 'Password must contain at least one number.');
  }

  // ── Uniqueness check ────────────────────────────────────────────────────────
  const existing = await Admin.findOne({ email: email.toLowerCase().trim() });
  if (existing) {
    return sendConflict(res, 'An account with this email already exists.');
  }

  // ── Hash password ────────────────────────────────────────────────────────────
  const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

  try {
    const newAdmin = await Admin.create({
      admin_name: admin_name.trim(),
      email:      email.toLowerCase().trim(),
      password:   hashedPassword,
      role,
    });

    // Never return the password hash
    const response = newAdmin.toObject();
    delete response.password;

    return sendCreated(res, `${role} account created successfully.`, response);
  } catch (err) {
    if (err.code === 11000) return handleDuplicateKeyError(res, err);
    if (err.name === 'ValidationError') return sendError(res, 400, err.message);
    throw err;
  }
});

// ─── GET ME ───────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/me
 * Return the authenticated admin's profile.
 * req.user is set by the authenticate middleware.
 */
const getMe = asyncHandler(async (req, res) => {
  const admin = await Admin.findById(req.user.id);
  if (!admin) return sendNotFound(res, 'Admin account');

  return sendSuccess(res, 200, 'Profile retrieved successfully.', buildUserResponse(admin));
});

// ─── UPDATE PASSWORD ──────────────────────────────────────────────────────────

/**
 * PUT /api/admin/me/password
 * Change own password.
 * Body: { currentPassword: string, newPassword: string }
 */
const updatePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};

  if (!currentPassword || !newPassword) {
    return sendError(res, 400, 'currentPassword and newPassword are required.');
  }

  if (newPassword.length < 8) {
    return sendError(res, 400, 'New password must be at least 8 characters long.');
  }

  if (!/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
    return sendError(
      res,
      400,
      'New password must contain at least one uppercase letter and one number.',
    );
  }

  // Load with password for comparison
  const admin = await Admin.findById(req.user.id).select('+password');
  if (!admin) return sendNotFound(res, 'Admin account');

  const isValid = await bcrypt.compare(currentPassword, admin.password);
  if (!isValid) {
    return sendError(res, 401, 'Current password is incorrect.');
  }

  if (currentPassword === newPassword) {
    return sendError(res, 400, 'New password must differ from the current password.');
  }

  admin.password = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await admin.save();

  return sendSuccess(res, 200, 'Password updated successfully.');
});

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  loginAdmin,
  createAdmin,
  getMe,
  updatePassword,
};