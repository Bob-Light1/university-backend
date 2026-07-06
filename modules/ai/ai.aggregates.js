'use strict';

/**
 * @file ai.aggregates.js
 * @description Registry of the deterministic ERP aggregates served by
 * GET /internal/ai/aggregates/:name (design doc §8 M5, §6.5/§6.6 M5b).
 * Figures are computed by the ERP through the existing module service
 * facades — the AI narrates them, it NEVER computes any (ADR-4). Every
 * aggregate is campus-scoped by construction and PII-free: counters, rates
 * and distributions only, never a student/prospect name or id.
 *
 * Two role tiers (defense in depth — the S2S subject is the end user):
 *  - analytics reports (M5): staffing roles, mirror of the public route;
 *  - advisor aggregates (M5b): direction roles only (D9).
 *
 * The same param validation is applied twice with one implementation: by the
 * public gateway (POST body) and by the internal API (query params). The
 * advisor param whitelists live here too, for the same reason.
 */

const mongoose = require('mongoose');
const { AI_ANALYTICS_REPORTS, AI_ADVISOR_AGGREGATES, AI_ADVISORS } = require('../../shared/constants/ai.constants');

// Lazy facades — module hubs are always required at call time (same pattern
// as the document facade in ai.internal.controller).
const resultService = () => require('../result').service;
const studentService = () => require('../student').service;
const financeService = () => require('../finance').service;
const partnerService = () => require('../partner').service;

/** Roles allowed to read analytics aggregates (mirror of the gateway route). */
const ANALYTICS_ROLES = Object.freeze(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'STAFF', 'TEACHER']);

/** Roles allowed to run advisors and read their aggregates (D9). */
const ADVISOR_ROLES = Object.freeze(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']);

/**
 * Per-param validators. Enum/format truth stays in the owning module
 * (result.service) — never duplicated here.
 */
const PARAM_VALIDATORS = {
  academicYear: (value) =>
    (resultService().isValidAcademicYear(value) ? null : 'academicYear must match YYYY-YYYY'),
  semester: (value) =>
    (resultService().isValidSemester(value) ? null : 'semester is not a valid semester value'),
  months: (value) =>
    (/^\d+$/.test(value) && Number(value) >= 3 && Number(value) <= 24
      ? null
      : 'months must be an integer between 3 and 24'),
};

/**
 * Aggregate registry: name → { params: allowed param names, roles, compute }.
 * compute({ campusId, params }) returns the flat figures object.
 */
const AGGREGATES = {
  [AI_ANALYTICS_REPORTS.CLASS_PERFORMANCE]: {
    params: ['academicYear', 'semester'],
    roles: ANALYTICS_ROLES,
    compute: ({ campusId, params }) =>
      resultService().getCampusOverviewAggregates({ campusId, ...params }),
  },

  [AI_ANALYTICS_REPORTS.ATTENDANCE_SUMMARY]: {
    params: [],
    roles: ANALYTICS_ROLES,
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
    roles: ANALYTICS_ROLES,
    compute: ({ campusId, params }) =>
      resultService().getDropoutRiskDistribution({ campusId, ...params }),
  },

  // ── Advisor aggregates (M5b, direction roles only — D9) ────────────────────

  [AI_ADVISOR_AGGREGATES.FINANCE_OVERDUE_AGING]: {
    params: [],
    roles: ADVISOR_ROLES,
    compute: ({ campusId }) =>
      financeService().getOverdueAgingAggregates({ campusId }),
  },

  [AI_ADVISOR_AGGREGATES.FINANCE_CASHFLOW_MONTHLY]: {
    params: ['months'],
    roles: ADVISOR_ROLES,
    compute: ({ campusId, params }) =>
      financeService().getMonthlyCashflowSeries({ campusId, ...params }),
  },

  [AI_ADVISOR_AGGREGATES.LEAD_FUNNEL]: {
    params: [],
    roles: ADVISOR_ROLES,
    compute: ({ campusId }) =>
      partnerService().getLeadFunnelAggregates({ campusId }),
  },
};

/**
 * Advisor registry (M5b): gateway-side param whitelist per advisor. The
 * composition itself (which aggregates, engine passes, prompts) lives in
 * ai-service — Node only forwards validated params and lets the internal
 * aggregates API re-validate each aggregate read (defense in depth).
 */
const ADVISORS = {
  [AI_ADVISORS.FINANCE]: { params: ['months'] },
  [AI_ADVISORS.ACADEMIC]: { params: ['academicYear', 'semester'] },
  [AI_ADVISORS.MARKETING]: { params: [] },
};

/** @returns {boolean} whether `name` is a served aggregate/report. */
const isKnownAggregate = (name) => Object.prototype.hasOwnProperty.call(AGGREGATES, name);

/** @returns {boolean} whether `name` is a served advisor (M5b). */
const isKnownAdvisor = (name) => Object.prototype.hasOwnProperty.call(ADVISORS, name);

/** @returns {readonly string[]} roles allowed to read one known aggregate. */
const aggregateRoles = (name) => AGGREGATES[name].roles;

/**
 * Validates and narrows a param object against a whitelist: unknown keys are
 * rejected (not silently dropped — a typo must not widen a filter), known
 * keys are format-checked by the owning module.
 * @param {string[]} allowed - Allowed param names.
 * @param {Object} params - Raw params (body or query).
 * @param {string} label - Registry entry name (error messages).
 * @returns {{ errors: Array<{field: string, message: string}>, params: Object }}
 */
const validateParams = (allowed, params, label) => {
  const errors = [];
  const clean = {};
  for (const [key, value] of Object.entries(params)) {
    if (!allowed.includes(key)) {
      errors.push({ field: key, message: `unknown param for '${label}'` });
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
 * Validates the params of one aggregate (name must be known).
 * @param {string} name
 * @param {Object} params - Raw params (body or query).
 * @returns {{ errors: Array<{field: string, message: string}>, params: Object }}
 */
const validateAggregateParams = (name, params = {}) =>
  validateParams(AGGREGATES[name].params, params, name);

/**
 * Validates the params of one advisor run (name must be known) — same
 * machinery and validators as the aggregates (single implementation).
 * @param {string} name
 * @param {Object} params - Raw params (gateway body).
 * @returns {{ errors: Array<{field: string, message: string}>, params: Object }}
 */
const validateAdvisorParams = (name, params = {}) =>
  validateParams(ADVISORS[name].params, params, name);

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
  ADVISOR_ROLES,
  isKnownAggregate,
  isKnownAdvisor,
  aggregateRoles,
  validateParams,
  validateAggregateParams,
  validateAdvisorParams,
  computeAggregate,
};
