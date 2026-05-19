'use strict';

/**
 * @file parentPasswordSchema.js
 * @description Validation middleware for parent password operations.
 *
 *  Endpoints:
 *    PUT  /api/parents/me/password       → validateChangePassword
 *    PATCH /api/parents/:id/reset-password → no body validation needed (temp pwd generated server-side)
 */

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────

/**
 * Validates a parent's own password-change request.
 * Requires currentPassword + newPassword.
 * confirmPassword is a frontend-only check — backend ignores it.
 *
 * @route PUT /api/parents/me/password
 */
const validateChangePassword = (req, res, next) => {
  const errors = [];
  const { currentPassword, newPassword } = req.body;

  // currentPassword
  if (!currentPassword || typeof currentPassword !== 'string' || currentPassword.trim() === '') {
    errors.push({ field: 'currentPassword', message: 'Current password is required.' });
  }

  // newPassword
  if (!newPassword || typeof newPassword !== 'string') {
    errors.push({ field: 'newPassword', message: 'New password is required.' });
  } else {
    if (newPassword.length < 8) {
      errors.push({ field: 'newPassword', message: 'New password must be at least 8 characters.' });
    }
    if (newPassword.length > 128) {
      errors.push({ field: 'newPassword', message: 'New password must not exceed 128 characters.' });
    }
    if (currentPassword && newPassword === currentPassword) {
      errors.push({ field: 'newPassword', message: 'New password must differ from the current password.' });
    }
  }

  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: 'Validation failed.', errors });
  }
  next();
};

module.exports = { validateChangePassword };
