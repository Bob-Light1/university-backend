'use strict';

/**
 * @file ai.self.js
 * @description Registry of the self-scoped ERP reads served by
 * GET /internal/ai/me/:resource — the read-only "function calls" the chat
 * assistant may invoke on behalf of the end user (design doc §7, "what is my
 * average?").
 *
 * Security invariant (§7, §4.1.4): the subject whose data is read is ALWAYS
 * the S2S token identity (`req.s2s.userId` + `campusId`), NEVER an id supplied
 * by the LLM or the prompt — otherwise a user could read another user's data.
 * The internal controller therefore passes only { userId, campusId, params };
 * `params` are report FILTERS (academicYear/semester), never scope, and are
 * validated by the same machinery as the campus aggregates (single source of
 * truth for the format validators).
 *
 * Figures are computed by the owning module through its service facade (ADR-4:
 * the ERP computes numbers, the AI narrates them) and are PII-free for the
 * subject's own data by construction.
 */

const { validateParams } = require('./ai.aggregates');

// Lazy facade — module hubs are always required at call time (same pattern as
// the document/result facades in ai.internal.controller / ai.aggregates).
const resultService = () => require('../result').service;

/** Roles that own a personal grade book (v1: students only). */
const STUDENT_SELF_ROLES = Object.freeze(['STUDENT']);

/**
 * Self-resource registry: name → { params, roles, compute }.
 * compute({ userId, campusId, params }) returns the flat, PII-free figures of
 * the CALLER's own data (userId = the S2S subject).
 */
const SELF_RESOURCES = {
  'grades-summary': {
    params: ['academicYear', 'semester'],
    roles: STUDENT_SELF_ROLES,
    compute: ({ userId, campusId, params }) =>
      resultService().getStudentGradesSummary({ studentId: userId, campusId, ...params }),
  },
};

/** @returns {boolean} whether `name` is a served self-resource. */
const isKnownSelfResource = (name) =>
  Object.prototype.hasOwnProperty.call(SELF_RESOURCES, name);

/** @returns {readonly string[]} roles allowed to read one known self-resource. */
const selfResourceRoles = (name) => SELF_RESOURCES[name].roles;

/**
 * Validates the params of one self-resource read (name must be known) — same
 * whitelist/validator machinery as the campus aggregates.
 * @param {string} name
 * @param {Object} params - Raw params (query).
 * @returns {{ errors: Array<{field: string, message: string}>, params: Object }}
 */
const validateSelfParams = (name, params = {}) =>
  validateParams(SELF_RESOURCES[name].params, params, name);

/**
 * Computes one self-resource for the calling user. Caller has already
 * authenticated the S2S token, authorized the role and validated the params.
 * @param {string} name - Known self-resource name.
 * @param {{ userId: string, campusId: string, params: Object }} scope
 * @returns {Promise<Object>} flat, PII-free figures of the caller's own data.
 */
const computeSelfResource = (name, { userId, campusId, params }) =>
  SELF_RESOURCES[name].compute({ userId, campusId, params });

module.exports = {
  STUDENT_SELF_ROLES,
  isKnownSelfResource,
  selfResourceRoles,
  validateSelfParams,
  computeSelfResource,
};
