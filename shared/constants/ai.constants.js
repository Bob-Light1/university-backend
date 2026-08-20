'use strict';

/**
 * @file ai.constants.js
 * @description AI "Premium" entitlement constants (Phase 3 — PHASE3_AI_DESIGN.md
 * §11.3, decision D10). Single source of truth for plans, features and gateway
 * error codes: the Campus model, the `ai` module middleware, the admin
 * entitlement endpoint and the frontend Yup schemas all mirror these values.
 */

const { FEATURE_PLANS } = require('./features.constants');

/**
 * Per-campus AI plans (§11.3) — an ALIAS of the platform tiers, never a second
 * grid (CAMPUS_ENTITLEMENT_DESIGN.md, decision D-D and phase 2).
 *
 * The AI was priced first and the module grid was aligned onto it; deriving the
 * alias in this direction keeps the AI's own vocabulary readable at its call
 * sites while making a divergence impossible — renaming a tier in the registry
 * renames it here, and the two can no longer drift into two sales pitches.
 *
 * `FEATURE_PLANS.CUSTOM` is deliberately absent: a bespoke MODULE offer says
 * nothing about an AI tier, and ai-service knows three. `aiPlanOf()`
 * (`shared/lib/entitlement/entitlement.ai.js`) narrows it back to `free`.
 */
const AI_PLANS = Object.freeze({
  FREE: FEATURE_PLANS.FREE,
  STANDARD: FEATURE_PLANS.STANDARD,
  PREMIUM: FEATURE_PLANS.PREMIUM,
});

/** AI features toggled per plan (value gradient §1.4.2). */
const AI_FEATURES = Object.freeze({
  CHAT: 'chat',
  SEARCH: 'search',
  ANALYTICS: 'analytics',
  ADVISORS: 'advisors',
});

/**
 * Default budget + feature set applied when a campus is switched to a plan
 * without explicit overrides (D10). monthlyTokenBudget 0 means unlimited
 * (ADMIN only, §11.3).
 */
const AI_PLAN_PRESETS = Object.freeze({
  [AI_PLANS.FREE]: Object.freeze({
    monthlyTokenBudget: 200000,
    features: Object.freeze({ chat: true, search: true, analytics: false, advisors: false }),
  }),
  [AI_PLANS.STANDARD]: Object.freeze({
    monthlyTokenBudget: 1000000,
    features: Object.freeze({ chat: true, search: true, analytics: true, advisors: false }),
  }),
  [AI_PLANS.PREMIUM]: Object.freeze({
    monthlyTokenBudget: 5000000,
    features: Object.freeze({ chat: true, search: true, analytics: true, advisors: true }),
  }),
});

/**
 * Descriptive analytics reports (Feature 2, M5 — design doc §8). One report =
 * one deterministic ERP aggregate narrated by the AI; report names are shared
 * verbatim by the gateway route, the internal aggregates API and ai-service.
 */
const AI_ANALYTICS_REPORTS = Object.freeze({
  CLASS_PERFORMANCE: 'class-performance',
  ATTENDANCE_SUMMARY: 'attendance-summary',
  DROPOUT_RISK: 'dropout-risk',
});

/**
 * Business advisors (Feature §6.6, M5b — decision D9). One advisor = a
 * deterministic engine pass over ERP aggregates + an LLM narration, in strict
 * proposal mode (human-in-the-loop, zero ERP write). Names are shared verbatim
 * by the gateway route and ai-service.
 */
const AI_ADVISORS = Object.freeze({
  FINANCE: 'finance',
  ACADEMIC: 'academic',
  MARKETING: 'marketing',
});

/**
 * Aggregates served to the advisors on top of the analytics reports (M5b).
 * Same internal endpoint (GET /internal/ai/aggregates/:name), stricter role
 * gate (direction roles only, D9) — still PII-free by construction.
 */
const AI_ADVISOR_AGGREGATES = Object.freeze({
  FINANCE_OVERDUE_AGING: 'finance-overdue-aging',
  FINANCE_CASHFLOW_MONTHLY: 'finance-cashflow-monthly',
  LEAD_FUNNEL: 'lead-funnel',
});

/**
 * Vector-indexable source types (design D6). v1 indexed GED documents only;
 * the 2nd increment adds the PUBLIC portal corpus (programmes + FAQ) — public
 * marketing content, zero risk (§6.3). Personal/financial data is NEVER
 * vector-indexed. These strings are a frozen wire contract shared verbatim
 * with ai-service (app/core/constants.py mirrors them).
 */
const AI_SOURCE_TYPES = Object.freeze({
  DOCUMENT: 'document',
  PORTAL_PROGRAM: 'portal-program',
  PORTAL_FAQ: 'portal-faq',
});

/** Portal (public) source types served by the public-portal ingestion facade. */
const AI_PORTAL_SOURCE_TYPES = Object.freeze([
  AI_SOURCE_TYPES.PORTAL_PROGRAM,
  AI_SOURCE_TYPES.PORTAL_FAQ,
]);

/** Every ingestable source type accepted by GET /internal/ai/ingestables. */
const AI_INGESTABLE_SOURCE_TYPES = Object.freeze([
  AI_SOURCE_TYPES.DOCUMENT,
  ...AI_PORTAL_SOURCE_TYPES,
]);

/** Source types a retrieval (search / chat) may span (Annexe B, §9). */
const AI_SEARCHABLE_SOURCE_TYPES = Object.freeze([
  AI_SOURCE_TYPES.DOCUMENT,
  ...AI_PORTAL_SOURCE_TYPES,
]);

/** Gateway error codes — frozen API contract (design doc Annexe B). */
const AI_ERROR_CODES = Object.freeze({
  AI_DISABLED: 'AI_DISABLED',                       // 503 — AI_SERVICE_URL not configured
  AI_NOT_ENABLED: 'AI_NOT_ENABLED',                 // 403 — campus has not subscribed
  AI_FEATURE_NOT_IN_PLAN: 'AI_FEATURE_NOT_IN_PLAN', // 403 — feature outside the campus plan
  AI_BUDGET_EXCEEDED: 'AI_BUDGET_EXCEEDED',         // 429 — monthly token budget exhausted
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',             // 503 — ai-service timed out
  INTERNAL: 'INTERNAL',                             // 5xx — anything else
});

module.exports = {
  AI_PLANS,
  AI_FEATURES,
  AI_PLAN_PRESETS,
  AI_ANALYTICS_REPORTS,
  AI_ADVISORS,
  AI_ADVISOR_AGGREGATES,
  AI_ERROR_CODES,
  AI_SOURCE_TYPES,
  AI_PORTAL_SOURCE_TYPES,
  AI_INGESTABLE_SOURCE_TYPES,
  AI_SEARCHABLE_SOURCE_TYPES,
};
