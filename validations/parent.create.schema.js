'use strict';

/**
 * @file createParentSchema.js
 * @description Validation middleware for parent create & update requests.
 *
 *  Usage in router:
 *    router.post('/', validateCreateParent, createParent);
 *    router.put('/:id', validateUpdateParent, updateParent);
 *
 *  On failure  → 400 { success: false, message, errors: [{ field, message }] }
 *  On success  → calls next()
 */

const mongoose = require('mongoose');

// ── HELPERS ───────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const PHONE_RE = /^\+?[0-9\s()-]{6,20}$/;

const isObjectId = (v) => mongoose.Types.ObjectId.isValid(v);

/**
 * Validates a flat object of fields.
 * Returns an array of { field, message } errors.
 * @param {Object} body
 * @param {boolean} isCreate  - true → required fields enforced
 */
const runValidation = (body, isCreate) => {
  const errors = [];

  const req = (field, msg) => {
    if (isCreate) errors.push({ field, message: msg });
  };

  // firstName
  if (body.firstName !== undefined) {
    const v = String(body.firstName).trim();
    if (v.length < 2 || v.length > 50) {
      errors.push({ field: 'firstName', message: 'First name must be 2–50 characters.' });
    }
  } else if (isCreate) {
    req('firstName', 'First name is required.');
  }

  // lastName
  if (body.lastName !== undefined) {
    const v = String(body.lastName).trim();
    if (v.length < 2 || v.length > 50) {
      errors.push({ field: 'lastName', message: 'Last name must be 2–50 characters.' });
    }
  } else if (isCreate) {
    req('lastName', 'Last name is required.');
  }

  // email
  if (body.email !== undefined) {
    if (!EMAIL_RE.test(String(body.email).trim())) {
      errors.push({ field: 'email', message: 'Please provide a valid email address.' });
    }
  } else if (isCreate) {
    req('email', 'Email is required.');
  }

  // phone
  if (body.phone !== undefined) {
    if (!PHONE_RE.test(String(body.phone).trim())) {
      errors.push({ field: 'phone', message: 'Phone must be 6–20 digits (optional +, spaces, parentheses, dashes).' });
    }
  } else if (isCreate) {
    req('phone', 'Phone number is required.');
  }

  // password (required only on create)
  if (body.password !== undefined) {
    const p = String(body.password);
    if (p.length < 8 || p.length > 128) {
      errors.push({ field: 'password', message: 'Password must be 8–128 characters.' });
    }
  } else if (isCreate) {
    req('password', 'Password is required.');
  }

  // gender
  if (body.gender !== undefined) {
    if (!['male', 'female'].includes(body.gender)) {
      errors.push({ field: 'gender', message: "Gender must be 'male' or 'female'." });
    }
  } else if (isCreate) {
    req('gender', 'Gender is required.');
  }

  // relationship
  if (body.relationship !== undefined) {
    if (!['father', 'mother', 'guardian', 'other'].includes(body.relationship)) {
      errors.push({ field: 'relationship', message: "Relationship must be 'father', 'mother', 'guardian', or 'other'." });
    }
  } else if (isCreate) {
    req('relationship', 'Relationship is required.');
  }

  // schoolCampus (required on create for ADMIN/DIRECTOR; CM uses JWT — validated in controller)
  if (body.schoolCampus !== undefined) {
    if (!isObjectId(body.schoolCampus)) {
      errors.push({ field: 'schoolCampus', message: 'schoolCampus must be a valid ObjectId.' });
    }
  }

  // children (optional array of ObjectIds, max 10)
  if (body.children !== undefined) {
    if (!Array.isArray(body.children)) {
      errors.push({ field: 'children', message: 'children must be an array.' });
    } else if (body.children.length > 10) {
      errors.push({ field: 'children', message: 'A parent cannot have more than 10 children.' });
    } else {
      body.children.forEach((id, i) => {
        if (!isObjectId(id)) {
          errors.push({ field: `children[${i}]`, message: `children[${i}] is not a valid ObjectId.` });
        }
      });
    }
  }

  // dateOfBirth (optional, must be past)
  if (body.dateOfBirth !== undefined && body.dateOfBirth !== null) {
    const d = new Date(body.dateOfBirth);
    if (isNaN(d.getTime())) {
      errors.push({ field: 'dateOfBirth', message: 'dateOfBirth must be a valid date.' });
    } else if (d >= new Date()) {
      errors.push({ field: 'dateOfBirth', message: 'dateOfBirth must be in the past.' });
    }
  }

  // nationalId (optional, max 50)
  if (body.nationalId !== undefined && body.nationalId !== null) {
    if (String(body.nationalId).trim().length > 50) {
      errors.push({ field: 'nationalId', message: 'National ID must not exceed 50 characters.' });
    }
  }

  // occupation (optional, max 100)
  if (body.occupation !== undefined && body.occupation !== null) {
    if (String(body.occupation).trim().length > 100) {
      errors.push({ field: 'occupation', message: 'Occupation must not exceed 100 characters.' });
    }
  }

  // address (optional object)
  if (body.address !== undefined && body.address !== null) {
    if (typeof body.address !== 'object' || Array.isArray(body.address)) {
      errors.push({ field: 'address', message: 'address must be an object.' });
    }
    // No strict field checks — all sub-fields are optional strings
  }

  // preferredLanguage (optional)
  if (body.preferredLanguage !== undefined) {
    if (!['fr', 'en', 'es', 'ar'].includes(body.preferredLanguage)) {
      errors.push({ field: 'preferredLanguage', message: "preferredLanguage must be 'fr', 'en', 'es', or 'ar'." });
    }
  }

  // notificationPrefs (optional object with boolean fields)
  if (body.notificationPrefs !== undefined && body.notificationPrefs !== null) {
    const prefs = body.notificationPrefs;
    if (typeof prefs !== 'object' || Array.isArray(prefs)) {
      errors.push({ field: 'notificationPrefs', message: 'notificationPrefs must be an object.' });
    } else {
      ['email', 'sms', 'push'].forEach((key) => {
        if (key in prefs && typeof prefs[key] !== 'boolean') {
          errors.push({ field: `notificationPrefs.${key}`, message: `notificationPrefs.${key} must be a boolean.` });
        }
      });
    }
  }

  // notes (optional, max 500 — admin-only, controller strips it for non-admins)
  if (body.notes !== undefined && body.notes !== null) {
    if (String(body.notes).length > 500) {
      errors.push({ field: 'notes', message: 'Notes must not exceed 500 characters.' });
    }
  }

  return errors;
};

// ── MIDDLEWARE EXPORTS ────────────────────────────────────────────────────────

/**
 * Multer delivers repeated form fields as a bare string when only one value is
 * appended (fd.append('children', id) × 1 → string, not array).
 * Normalize to array before validation so "1 child selected" doesn't fail.
 */
const normalizeChildren = (req) => {
  if (req.body.children !== undefined && !Array.isArray(req.body.children)) {
    req.body.children = req.body.children ? [req.body.children] : [];
  }
};

/**
 * Validates a parent creation request body.
 * @route POST /api/parents
 */
const validateCreateParent = (req, res, next) => {
  normalizeChildren(req);
  const errors = runValidation(req.body, true);
  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: 'Validation failed.', errors });
  }
  next();
};

/**
 * Validates a parent update request body (all fields optional).
 * @route PUT /api/parents/:id
 */
const validateUpdateParent = (req, res, next) => {
  normalizeChildren(req);
  const errors = runValidation(req.body, false);
  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: 'Validation failed.', errors });
  }
  next();
};

/**
 * Validates a parent profile self-update (phone, address, preferredLanguage, notificationPrefs).
 * @route PUT /api/parents/me/profile
 */
const validateUpdateProfile = (req, res, next) => {
  const errors = [];
  const { phone, address, preferredLanguage, notificationPrefs } = req.body;

  if (phone !== undefined) {
    if (!PHONE_RE.test(String(phone).trim())) {
      errors.push({ field: 'phone', message: 'Phone must be 6–20 digits (optional +, spaces, parentheses, dashes).' });
    }
  }

  if (address !== undefined && address !== null) {
    if (typeof address !== 'object' || Array.isArray(address)) {
      errors.push({ field: 'address', message: 'address must be an object.' });
    }
  }

  if (preferredLanguage !== undefined) {
    if (!['fr', 'en', 'es', 'ar'].includes(preferredLanguage)) {
      errors.push({ field: 'preferredLanguage', message: "preferredLanguage must be 'fr', 'en', 'es', or 'ar'." });
    }
  }

  if (notificationPrefs !== undefined && notificationPrefs !== null) {
    if (typeof notificationPrefs !== 'object' || Array.isArray(notificationPrefs)) {
      errors.push({ field: 'notificationPrefs', message: 'notificationPrefs must be an object.' });
    } else {
      ['email', 'sms', 'push'].forEach((key) => {
        if (key in notificationPrefs && typeof notificationPrefs[key] !== 'boolean') {
          errors.push({ field: `notificationPrefs.${key}`, message: `notificationPrefs.${key} must be a boolean.` });
        }
      });
    }
  }

  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: 'Validation failed.', errors });
  }
  next();
};

module.exports = { validateCreateParent, validateUpdateParent, validateUpdateProfile };
