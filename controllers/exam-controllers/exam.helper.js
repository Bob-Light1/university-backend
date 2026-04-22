'use strict';

/**
 * @file exam_helper.js
 * @description Shared helpers for the SEMS examination controllers.
 *  Mirrors result.helper.js — every service function MUST use getCampusFilter().
 */

const mongoose = require('mongoose');
const { buildCampusFilter, isValidObjectId } = require('../../utils/validationHelpers');
const { sendForbidden } = require('../../utils/responseHelpers');

// ─── ROLE GUARDS ──────────────────────────────────────────────────────────────

/** true for ADMIN and DIRECTOR — cross-campus read + global write access */
const isGlobalRole  = (role) => role === 'ADMIN' || role === 'DIRECTOR';

/** true for ADMIN, DIRECTOR, CAMPUS_MANAGER */
const isManagerRole = (role) => isGlobalRole(role) || role === 'CAMPUS_MANAGER';

// ─── CAMPUS FILTER ────────────────────────────────────────────────────────────

/**
 * Returns the schoolCampus MongoDB filter to be applied on every SEMS query.
 *
 * Usage inside async controllers:
 *   const filter = getCampusFilter(req, res);
 *   if (!filter) return;
 *
 * @param {Object} req
 * @param {Object} res
 * @returns {Object|null}
 */
const getCampusFilter = (req, res) => {
  try {
    return buildCampusFilter(req.user, req.query.campusId || null);
  } catch (err) {
    console.error('[SEMS CampusIsolation] getCampusFilter breach:', err.message);
    if (res && !res.headersSent) {
      sendForbidden(res, 'Campus information is missing from your session. Please log in again.');
    }
    return null;
  }
};

/**
 * Resolves the effective campusId from the authenticated user.
 * ADMIN/DIRECTOR may override with a body or query value.
 */
const resolveCampusId = (req, campusFromBody) => {
  const { role, campusId: userCampusId } = req.user;
  return isGlobalRole(role)
    ? (campusFromBody || userCampusId || null)
    : userCampusId || null;
};

// ─── AGGREGATION CAST ─────────────────────────────────────────────────────────

/**
 * Casts schoolCampus to ObjectId in a filter intended for aggregate $match stages.
 * Mongoose auto-casts in find() but NOT in aggregation pipelines.
 */
const castForAggregation = (filter) => {
  if (!filter.schoolCampus) return filter;
  return {
    ...filter,
    schoolCampus: new mongoose.Types.ObjectId(String(filter.schoolCampus)),
  };
};

// ─── PAGINATION ───────────────────────────────────────────────────────────────

const parsePagination = (query) => {
  const page  = Math.max(1, parseInt(query.page,  10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  const skip  = (page - 1) * limit;
  return { page, limit, skip };
};

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  isGlobalRole,
  isManagerRole,
  getCampusFilter,
  resolveCampusId,
  castForAggregation,
  parsePagination,
};
