/**
 * Validation Helpers (pure)
 * Format validation, multi-tenant filter building and permission checks.
 * No model access here — campus-membership checks live in the owner module
 * services (teacher.service.validateTeacherBelongsToCampus,
 * student.service.validateStudentBelongsToCampus).
 */

const mongoose = require('mongoose');

/**
 * Validate MongoDB ObjectId format
 * @param {String} id - ID to validate
 * @returns {Boolean}
 */
const isValidObjectId = (id) => {
  return mongoose.Types.ObjectId.isValid(id);
};

/**
 * Validate multiple ObjectIds
 * @param {Array} ids - Array of IDs to validate
 * @returns {Boolean}
 */
const areValidObjectIds = (ids) => {
  if (!Array.isArray(ids)) return false;
  return ids.every(id => isValidObjectId(id));
};

/**
 * Validate email format
 * @param {String} email - Email to validate
 * @returns {Boolean}
 */
const isValidEmail = (email) => {
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return emailRegex.test(email);
};

/**
 * Validate phone number format
 * @param {String} phone - Phone to validate
 * @returns {Boolean}
 */
const isValidPhone = (phone) => {
  const phoneRegex = /^\+?[0-9\s()-]{6,20}$/;
  return phoneRegex.test(phone);
};

/**
 * Validate password strength.
 * Policy (all user types): ≥8 chars · lowercase · uppercase · digit · symbol · no spaces.
 * @param {String} password
 * @returns {{ valid: Boolean, errors: String[] }}
 */
const validatePasswordStrength = (password) => {
  const errors = [];

  if (!password || password.length < 8) {
    errors.push('Password must be at least 8 characters long');
  }

  if (password && password.length > 128) {
    errors.push('Password must not exceed 128 characters');
  }

  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }

  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }

  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }

  // eslint-disable-next-line no-useless-escape
  if (!/[!@#$%^&*()_\-+=\[\]{};:'",.<>?\/\\|~]/.test(password)) {
    errors.push('Password must contain at least one special character (e.g. !@#$%)');
  }

  if (/\s/.test(password)) {
    errors.push('Password must not contain spaces');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
};

/**
 * Validate user has permission to access campus resources
 * @param {Object} user - User from JWT (req.user)
 * @param {String} campusId - Campus ID to access
 * @returns {Boolean}
 */
const canAccessCampus = (user, campusId) => {
  // ADMIN and DIRECTOR can access all campuses
  if (user.role === 'ADMIN' || user.role === 'DIRECTOR') {
    return true;
  }

  // CAMPUS_MANAGER can only access their own campus
  if (user.role === 'CAMPUS_MANAGER') {
    return user.campusId && user.campusId.toString() === campusId.toString();
  }

  // Other roles (TEACHER, STUDENT) can only access their campus
  return user.campusId && user.campusId.toString() === campusId.toString();
};

/**
 * Build a MongoDB campus isolation filter based on the authenticated user's role.
 *
 * CRITICAL — multi-tenant security boundary.
 *
 * Rules:
 *  - ADMIN / DIRECTOR : cross-campus access. An optional `requestedCampusId`
 *    narrows the query; without it, no campus filter is applied (full access).
 *  - All other roles  : MUST have a valid campusId in their JWT payload.
 *    If campusId is missing or invalid an Error is thrown so that the caller
 *    can return a 403/500 instead of silently leaking data from every campus
 *    (Mongoose ignores { schoolCampus: undefined } → full collection scan).
 *
 * @param {Object}  user               - req.user (decoded JWT payload)
 * @param {string|null} requestedCampusId - Optional campus override (ADMIN/DIRECTOR only)
 * @returns {Object} MongoDB filter  e.g. { schoolCampus: ObjectId }
 * @throws  {Error}  When a non-global role has no valid campusId
 */
const buildCampusFilter = (user, requestedCampusId = null) => {
  const GLOBAL_ROLES = ['ADMIN', 'DIRECTOR'];

  if (GLOBAL_ROLES.includes(user.role)) {
    // Global roles: optionally scope to a specific campus
    return requestedCampusId && isValidObjectId(requestedCampusId)
      ? { schoolCampus: requestedCampusId }
      : {};
  }

  // All non-global roles MUST have a campus bound in their JWT.
  // Throw synchronously so callers can catch and return 403.
  if (!user.campusId || !isValidObjectId(String(user.campusId))) {
    throw new Error(
      `Campus isolation breach prevented: role '${user.role}' has no valid campusId in JWT.`
    );
  }

  return { schoolCampus: user.campusId };
};

/**
 * Escape special regex characters in a string to prevent ReDoS / injection
 * when using user-supplied input in MongoDB $regex queries.
 *
 * @param {string} str - Raw user input
 * @returns {string} Escaped string safe for use as a regex pattern
 */
const escapeRegex = (str) =>
  String(str ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Sanitize user input to prevent injection attacks
 * @param {String} input - User input
 * @returns {String} Sanitized input
 */
const sanitizeInput = (input) => {
  if (typeof input !== 'string') return input;

  // Remove potentially dangerous characters
  return input
    .trim()
    .replace(/[<>]/g, '') // Remove < and >
    .replace(/javascript:/gi, '') // Remove javascript: protocol
    .replace(/on\w+=/gi, ''); // Remove event handlers
};

/**
 * Validate date is not in the future
 * @param {Date} date - Date to validate
 * @returns {Boolean}
 */
const isDateNotFuture = (date) => {
  if (!date) return true;
  return new Date(date) < new Date();
};

/**
 * Check if user owns a resource
 * @param {Object} user - User from JWT
 * @param {String} resourceOwnerId - ID of resource owner
 * @returns {Boolean}
 */
const isResourceOwner = (user, resourceOwnerId) => {
  if (!user || !user.id || !resourceOwnerId) {
    return false;
  }
  return user.id.toString() === resourceOwnerId.toString();
};

module.exports = {
  // ObjectId validation
  isValidObjectId,
  areValidObjectIds,

  // Permission validation
  canAccessCampus,
  buildCampusFilter,
  isResourceOwner,

  // Input validation
  isValidEmail,
  isValidPhone,
  validatePasswordStrength,
  sanitizeInput,
  isDateNotFuture,
  escapeRegex,
};
