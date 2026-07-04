'use strict';

/**
 * @file ai.aggregates.js
 * @description Registry of the deterministic ERP aggregates served by
 * GET /internal/ai/aggregates/:name (design doc §8, M5). Figures are computed
 * by the ERP through the existing module service facades — the AI narrates
 * them, it NEVER computes any (ADR-4). Every aggregate is campus-scoped by
 * construction and PII-free: counters, rates and distributions only, never a
 * student name or id.
 *
 * The same param validation is applied twice (defense in depth): by the
 * public gateway (POST /api/ai/analytics/:report body) and by the internal
 * API (query params) — one implementation, exported here.
 */

const mongoose = require('mongoose');
const { AI_ANALYTICS_REPORTS } = require('../../shared/constants/ai.constants');

// Lazy facades — module hubs are always required at call time (same pattern
// as the document facade in ai.internal.controller).
const resultService = () => require('../result').service;
const studentService = () => require('../student').service;

/** Roles allowed to read analytics aggregates (mirror of the gateway route). */
const ANALYTICS_ROLES = Object.freeze(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'STAFF', 'TEACHER']);

/**
 * Per-param validators. Enum/format truth stays in the owning module
 * (result.service) — never duplicated here.
 */
const PARAM_VALIDATORS = {
  academicYear: (value) =>
    (resultService().isValidAcademicYear(value) ? null : 'academicYear must match YYYY-YYYY'),
  semester: (value) =>
    (resultService().isValidSemester(value) ? null : 'semester is not a valid semester value'),
};

/**
 * Aggregate registry: name → { params: allowed param names, compute }.
 * compute({ campusId, params }) returns the flat figures object.
 */
const AGGREGATES = {
  [AI_ANALYTICS_REPORTS.CLASS_PERFORMANCE]: {
    params: ['academicYear', 'semester'],
    compute: ({ campusId, params }) =>
      resultService().getCampusOverviewAggregates({ campusId, ...params }),
  },

  [AI_ANALYTICS_REPORTS.ATTENDANCE_SUMMARY]: {
    params: [],
    compute: async ({ campusId }) => {
      const campusOid = new mongoose.Types.ObjectId(String(campusId));
      const [[totals], [absence]] = await Promise.all([
        studentService().summarizeAttendanceTotals({ campusId: campusOid }),
        studentService().getAvgAbsenceRateForCampus(campusOid),
      ]);
      const total = totals?.total ?? 0;
      const present = totals?.present ?? 0;
      return {
        totalSessions: total,
        presentCount: present,
        absentCount: total - present,
        attendanceRate: total > 0 ? Math.round((present / total) * 1000) / 10 : null,
        avgAbsenceRatePerStudent: absence?.avgAbsenceRate != null
          ? Math.round(absence.avgAbsenceRate * 10) / 10
          : null,
      };
    },
  },

  [AI_ANALYTICS_REPORTS.DROPOUT_RISK]: {
    params: ['academicYear', 'semester'],
    compute: ({ campusId, params }) =>
      resultService().getDropoutRiskDistribution({ campusId, ...params }),
  },
};

/** @returns {boolean} whether `name` is a served aggregate/report. */
const isKnownAggregate = (name) => Object.prototype.hasOwnProperty.call(AGGREGATES, name);

/**
 * Validates and narrows the params of one aggregate: unknown keys are
 * rejected (not silently dropped — a typo must not widen a filter), known
 * keys are format-checked by the owning module.
 * @param {string} name - Aggregate name (must be known).
 * @param {Object} params - Raw params (body or query).
 * @returns {{ errors: Array<{field: string, message: string}>, params: Object }}
 */
const validateAggregateParams = (name, params = {}) => {
  const allowed = AGGREGATES[name].params;
  const errors = [];
  const clean = {};
  for (const [key, value] of Object.entries(params)) {
    if (!allowed.includes(key)) {
      errors.push({ field: key, message: `unknown param for '${name}'` });
      continue;
    }
    if (typeof value !== 'string' || value.length === 0) {
      errors.push({ field: key, message: `${key} must be a non-empty string` });
      continue;
    }
    const formatError = PARAM_VALIDATORS[key] ? PARAM_VALIDATORS[key](value) : null;
    if (formatError) {
      errors.push({ field: key, message: formatError });
      continue;
    }
    clean[key] = value;
  }
  return { errors, params: clean };
};

/**
 * Computes one aggregate for a campus. Caller has already authenticated,
 * authorized the role and validated the params.
 * @param {string} name - Known aggregate name.
 * @param {{ campusId: string, params: Object }} scope
 * @returns {Promise<Object>} flat, PII-free figures.
 */
const computeAggregate = (name, { campusId, params }) =>
  AGGREGATES[name].compute({ campusId, params });

module.exports = {
  ANALYTICS_ROLES,
  isKnownAggregate,
  validateAggregateParams,
  computeAggregate,
};
