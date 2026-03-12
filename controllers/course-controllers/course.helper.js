'use strict';

/**
 * @file course.helper.js
 * @description Shared helpers and constants for all course controllers.
 *
 *  Imported by:
 *  • course.crud.controller.js
 *  • course.workflow.controller.js
 *  • course.resources.controller.js
 *
 *  Centralises:
 *  • Role guards
 *  • Allowed field whitelists (security: prevent injection)
 *  • Sort map for listCourses
 *  • Populate presets
 *  • Shared validation helpers
 */

const mongoose = require('mongoose');
const { isValidObjectId } = require('../../utils/validationHelpers');
const { APPROVAL_STATUS }  = require('../../models/course.model');

// ─── ROLE GUARDS ──────────────────────────────────────────────────────────────

/** ADMIN and DIRECTOR — cross-campus, full access */
const isGlobalRole = (role) => role === 'ADMIN' || role === 'DIRECTOR';

/** ADMIN, DIRECTOR, CAMPUS_MANAGER */
const isManagerRole = (role) => isGlobalRole(role) || role === 'CAMPUS_MANAGER';

// ─── FIELD WHITELISTS (injection prevention) ──────────────────────────────────

/**
 * Fields allowed on Course CREATE.
 * `schoolCampus` is intentionally absent — courses are global entities.
 */
const COURSE_WRITABLE_FIELDS = Object.freeze([
  'courseCode', 'title', 'category', 'level', 'discipline',
  'tags', 'languages', 'difficultyLevel', 'visibility',
  'description', 'objectives', 'prerequisites', 'syllabus',
  'durationWeeks', 'estimatedWorkload', 'creditHours', 'coverImage',
]);

/**
 * Fields that can be updated on an APPROVED course (non-pedagogical).
 * Pedagogical fields (title, objectives, syllabus, creditHours) are immutable
 * on APPROVED courses — use POST /new-version to revise them.
 */
const COURSE_APPROVED_MUTABLE_FIELDS = Object.freeze([
  'resources', 'coverImage', 'description', 'tags', 'visibility',
]);

/**
 * Pedagogical fields that trigger a 409 conflict when trying to update
 * an APPROVED course via PUT.
 */
const COURSE_IMMUTABLE_ON_APPROVED = Object.freeze([
  'title', 'objectives', 'syllabus', 'creditHours',
]);

/**
 * Fields allowed when CAMPUS_MANAGER adds a resource.
 * `addedBy` and `addedAt` are always injected by the controller — never from body.
 */
const RESOURCE_WRITABLE_FIELDS = Object.freeze([
  'title', 'type', 'url', 'mimeType', 'fileSize', 'isPublic',
]);

// ─── SORT MAP ─────────────────────────────────────────────────────────────────

/** Maps query `sort` parameter to a MongoDB sort object */
const SORT_MAP = Object.freeze({
  title_asc:        { title: 1 },
  title_desc:       { title: -1 },
  createdAt_desc:   { createdAt: -1 },
  createdAt_asc:    { createdAt: 1 },
  creditHours_asc:  { creditHours: 1 },
  version_desc:     { version: -1 },
});

const DEFAULT_SORT = SORT_MAP.createdAt_desc;

// ─── POPULATE PRESETS ─────────────────────────────────────────────────────────

/**
 * Reusable populate configurations for list and detail views.
 * Strict projections prevent over-exposure of sensitive fields.
 */
const COURSE_POPULATE = Object.freeze({
  LIST: [
    { path: 'level',                select: 'name description' },
    { path: 'prerequisites.course', select: 'courseCode title level category' },
    { path: 'createdBy',            select: 'firstName lastName' },
  ],
  DETAIL: [
    { path: 'level',                select: 'name description' },
    { path: 'prerequisites.course', select: 'courseCode title level category' },
    { path: 'createdBy',            select: 'firstName lastName email' },
    { path: 'approvalHistory.actor', select: 'firstName lastName' },
    { path: 'resources.addedBy',    select: 'firstName lastName' },
  ],
});

// ─── PAGINATION HELPER ────────────────────────────────────────────────────────

/**
 * Parse a raw query string value into a positive integer with a fallback.
 * @param {*}      val      - Raw value from query string
 * @param {number} fallback - Default value
 * @returns {number}
 */
const parsePositiveInt = (val, fallback) => {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// ─── SHARED VALIDATION ────────────────────────────────────────────────────────

/**
 * Validate that a value is a valid MongoDB ObjectId string.
 * Returns an error message string, or null if valid.
 * @param {*}      val   - Value to check
 * @param {string} label - Field name for the error message
 * @returns {string|null}
 */
const validateObjectIdField = (val, label) => {
  if (!val) return `${label} is required.`;
  if (!isValidObjectId(val)) return `Invalid ${label} format.`;
  return null;
};

/**
 * Pick only whitelisted keys from an object.
 * Prevents injection of unknown or forbidden fields.
 * @param {Object}   source    - Source object (e.g. req.body)
 * @param {string[]} whitelist - Allowed keys
 * @returns {Object}
 */
const pickFields = (source, whitelist) => {
  const result = {};
  for (const key of whitelist) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      result[key] = source[key];
    }
  }
  return result;
};

/**
 * Check whether a request body contains any pedagogically-immutable field
 * that must not be modified on an APPROVED course.
 * @param {Object} body - req.body
 * @returns {boolean}
 */
const hasPedagogicalFields = (body) =>
  COURSE_IMMUTABLE_ON_APPROVED.some((f) =>
    Object.prototype.hasOwnProperty.call(body, f),
  );

/**
 * Build the dynamic filter object for listCourses from query params.
 * Applies role-based visibility restrictions automatically.
 *
 * @param {Object} query               - req.query
 * @param {string} [query.search]      - Full-text search string
 * @param {string} [query.category]    - Course category enum value
 * @param {string} [query.level]       - Level ObjectId
 * @param {string} [query.discipline]  - Discipline substring (case-insensitive)
 * @param {string} [query.language]    - Language code
 * @param {string} [query.tag]         - Tag value
 * @param {string} [query.difficultyLevel] - Difficulty enum value
 * @param {'true'|'false'} [query.hasSyllabus]  - Filter by presence of syllabus units
 * @param {'true'|'false'} [query.hasResources] - Filter by presence of resources
 * @param {Object} user                - req.user
 * @returns {Object} MongoDB filter
 */
const buildCourseFilter = (query, user) => {
  const filter = { isDeleted: false };

  // Non-global roles always see latest APPROVED only
  const canSeeAllStatuses = isGlobalRole(user.role);

  // isLatestVersion
  if (!canSeeAllStatuses) {
    filter.isLatestVersion  = true;
    filter.approvalStatus   = APPROVAL_STATUS.APPROVED;
  } else {
    // Global roles can override
    if (query.isLatestVersion !== undefined) {
      filter.isLatestVersion = query.isLatestVersion === 'true';
    }
    if (query.approvalStatus) {
      filter.approvalStatus = query.approvalStatus;
    }
    if (query.includeDeleted === 'true' && user.role === 'ADMIN') {
      delete filter.isDeleted; // ADMIN only
    }
  }

  // Full-text search
  if (query.search) {
    filter.$text = { $search: query.search };
  }

  // Category
  if (query.category) filter.category = query.category;

  // Level (ObjectId)
  if (query.level && isValidObjectId(query.level)) {
    filter.level = new mongoose.Types.ObjectId(query.level);
  }

  // Discipline (case-insensitive regex)
  if (query.discipline) {
    filter.discipline = { $regex: query.discipline, $options: 'i' };
  }

  // Language
  if (query.language) filter.languages = query.language;

  // Tag
  if (query.tag) filter.tags = query.tag;

  // Difficulty level
  if (query.difficultyLevel) filter.difficultyLevel = query.difficultyLevel;

  // hasSyllabus — true: at least one syllabus unit / false: empty syllabus
  if (query.hasSyllabus !== undefined) {
    filter['syllabus.0'] = query.hasSyllabus === 'true'
      ? { $exists: true }
      : { $exists: false };
  }

  // hasResources — true: at least one resource / false: no resources
  if (query.hasResources !== undefined) {
    filter['resources.0'] = query.hasResources === 'true'
      ? { $exists: true }
      : { $exists: false };
  }

  return filter;
};

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  // Role guards
  isGlobalRole,
  isManagerRole,
  // Field whitelists
  COURSE_WRITABLE_FIELDS,
  COURSE_APPROVED_MUTABLE_FIELDS,
  COURSE_IMMUTABLE_ON_APPROVED,
  RESOURCE_WRITABLE_FIELDS,
  // Sort
  SORT_MAP,
  DEFAULT_SORT,
  // Populate
  COURSE_POPULATE,
  // Pagination
  parsePositiveInt,
  // Validation helpers
  validateObjectIdField,
  pickFields,
  hasPedagogicalFields,
  buildCourseFilter,
};