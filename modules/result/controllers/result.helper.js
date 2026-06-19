'use strict';

/**
 * @file result.helpers.js
 * @description Shared helpers and common validation for the results controllers.
 *
 *  This file is imported by :
 *  • result.crud.controller.js
 *  • result.workflow.controller.js
 *  • result.analytics.controller.js
 *
 *  It centralizes :
 *  • Role guards (isGlobalRole, isManagerRole)
 *  • Campus resolution from req
 *  • Validation of common fields (ID, enums, academicYear)
 *  • Pagination helpers
 */

const mongoose = require('mongoose');
const { buildCampusFilter, isValidObjectId } = require('../../../shared/utils/validation-helpers');
const { sendError, sendForbidden } = require('../../../shared/utils/response-helpers');
const { RESULT_STATUS, EVALUATION_TYPE, SEMESTER } = require('../models/result.model');

// ─── ROLE GUARDS ──────────────────────────────────────────────────────────────

/** true for ADMIN and DIRECTOR — cross-campus access and lock override */
const isGlobalRole  = (role) => role === 'ADMIN' || role === 'DIRECTOR';

/** true for ADMIN, DIRECTOR and CAMPUS_MANAGER */
const isManagerRole = (role) => isGlobalRole(role) || role === 'CAMPUS_MANAGER';

// ─── CAMPUS RESOLUTION ────────────────────────────────────────────────────────

/**
 * Returns the schoolCampus MongoDB filter to be applied on every Result query.
 *
 * Wraps buildCampusFilter from validationHelpers and converts a missing-campusId
 * breach into an Express-compatible 403 response so no data leaks silently.
 *
 * Usage inside async controllers:
 *   const filter = getCampusFilter(req, res);
 *   if (!filter) return; // response already sent
 *
 * @param {Object} req - Express request (req.user must be populated by authenticate)
 * @param {Object} res - Express response (used only when an error must be sent)
 * @returns {Object|null} MongoDB filter, or null when a 403 has been sent
 */
const getCampusFilter = (req, res) => {
  try {
    // Only ADMIN/DIRECTOR may pass an explicit campusId override via query param.
    // For all other roles buildCampusFilter ignores the second argument and uses
    // req.user.campusId exclusively — preventing cross-campus query injection.
    return buildCampusFilter(req.user, req.query.campusId || null);
  } catch (err) {
    // buildCampusFilter throws when a non-global role has no valid campusId.
    // Log the anomaly and return a 403 instead of leaking all campus data.
    console.error('[CampusIsolation] result.helper – getCampusFilter breach:', err.message);
    if (res && !res.headersSent) {
      sendForbidden(res, 'Campus information is missing from your session. Please log in again.');
    }
    return null;
  }
};

/**
 * Resolves the effective campusId from req.user + optional body.
 * ADMIN/DIRECTOR can specify an external campus ; others are limited
 * to their own campus.
 *
 * @param {Object} req
 * @param {string} [campusFromBody] - Optional value coming from the body
 * @returns {string|null}  resolved campusId, or null if absent
 */
const resolveCampusId = (req, campusFromBody) => {
  const { role, campusId: userCampusId } = req.user;
  return isGlobalRole(role)
    ? (campusFromBody || userCampusId || null)
    : userCampusId || null;
};

// ─── COMMON VALIDATION ────────────────────────────────────────────────────────

/**
 * Validates the contextual fields common to all result creations.
 * Returns null if everything is valid, or an error string.
 *
 * @param {Object} fields - { evaluationType, semester, academicYear, score, maxScore }
 * @returns {string|null}
 */
const validateResultContext = ({ evaluationType, semester, academicYear, score, maxScore }) => {
  if (!Object.values(EVALUATION_TYPE).includes(evaluationType))
    return `Invalid evaluationType. Must be: ${Object.values(EVALUATION_TYPE).join(', ')}.`;
  if (!Object.values(SEMESTER).includes(semester))
    return `Invalid semester. Must be: ${Object.values(SEMESTER).join(', ')}.`;
  if (!/^\d{4}-\d{4}$/.test(academicYear))
    return 'academicYear must be YYYY-YYYY (ex. 2024-2025).';
  if (score == null || maxScore == null)
    return 'score and maxScore are required.';
  if (Number(score) < 0 || Number(score) > Number(maxScore))
    return `Score (${score}) must be between 0 and maxScore (${maxScore}).`;
  return null;
};

/**
 * Validates the required ObjectId of a result.
 * Returns null if all are valid, or an error string.
 *
 * @param {Object} ids - { student, classId, subject, teacher }
 * @returns {string|null}
 */
const validateResultIds = ({ student, classId, subject, teacher }) => {
  if (!isValidObjectId(student))  return 'Invalid student ID.';
  if (!isValidObjectId(classId))  return 'Invalid class ID.';
  if (!isValidObjectId(subject))  return 'Invalid subject ID.';
  if (!isValidObjectId(teacher))  return 'Invalid teacher ID.';
  return null;
};

/**
 * Checks that a state transition is allowed.
 *
 * Valid transitions :
 *  DRAFT      → SUBMITTED  (teacher)
 *  SUBMITTED  → PUBLISHED  (manager)
 *  SUBMITTED  → DRAFT      (sent back for correction by manager)
 *  PUBLISHED  → ARCHIVED   (manager)
 *
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
const isValidTransition = (from, to) => {
  const allowed = {
    [RESULT_STATUS.DRAFT]:     [RESULT_STATUS.SUBMITTED],
    [RESULT_STATUS.SUBMITTED]: [RESULT_STATUS.PUBLISHED, RESULT_STATUS.DRAFT],
    [RESULT_STATUS.PUBLISHED]: [RESULT_STATUS.ARCHIVED],
    [RESULT_STATUS.ARCHIVED]:  [],
  };
  return (allowed[from] || []).includes(to);
};

// ─── PAGINATION HELPERS ───────────────────────────────────────────────────────

/**
 * Parses a query parameter into a positive integer with fallback.
 * @param {*}      val       - Raw value (query string)
 * @param {number} fallback  - Default value
 * @returns {number}
 */
const parsePositiveInt = (val, fallback) => {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  // Role guards
  isGlobalRole,
  isManagerRole,
  // Campus
  getCampusFilter,
  resolveCampusId,
  // Validation
  validateResultContext,
  validateResultIds,
  isValidTransition,
  // Pagination
  parsePositiveInt,
};