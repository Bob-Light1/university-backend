'use strict';

/**
 * @file ai.constants.js
 * @description AI "Premium" entitlement constants (Phase 3 — PHASE3_AI_DESIGN.md
 * §11.3, decision D10). Single source of truth for plans, features and gateway
 * error codes: the Campus model, the `ai` module middleware, the admin
 * entitlement endpoint and the frontend Yup schemas all mirror these values.
 */

/** Per-campus AI plans (§11.3). */
const AI_PLANS = Object.freeze({
  FREE: 'free',
  STANDARD: 'standard',
  PREMIUM: 'premium',
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
  AI_ERROR_CODES,
};
