'use strict';

/**
 * @file entitlement.legacy.js
 * @description The fold from the two legacy configuration objects of `Campus`
 * into the unified `entitlement` — written ONCE, used by the two places that
 * perform it (CAMPUS_ENTITLEMENT_DESIGN.md §10 phase 1.2 and phase 2).
 *
 *   features.max*            → entitlement.quotas.*
 *   aiEntitlement.plan       → entitlement.plan
 *   aiEntitlement.*Budget    → entitlement.quotas.aiMonthlyTokens
 *   aiEntitlement.llmProfile → entitlement.ai.llmProfile
 *   aiEntitlement.features   → entitlement.ai.features (deviations only)
 *   aiEntitlement.enabled    → the `ai` module state
 *
 * Two callers, one rule:
 *  - `scripts/migrate-entitlement.js`, deliberately, for the whole estate;
 *  - `applyChanges()`, on the FIRST write reaching a campus the migration has
 *    not covered yet — otherwise that write would store a plan with no
 *    grandfathering behind it, and every module outside the tier would vanish
 *    from a tenant that had been using it for months. A half-built entitlement
 *    is worse than none.
 *
 * ── WHY THE READ PATH DOES NOT FOLD ─────────────────────────────────────────
 * Deliberate asymmetry. Reading must never change what a campus can reach, so
 * an unmigrated campus keeps resolving to everything-enabled (fail-open, §4.3)
 * and the socle stays inert until the migration is run. Writing must never
 * leave a campus half-configured, so it folds first. Folding on read would
 * apply a tier nobody has decided yet; not folding on write would apply one
 * without its grandfathering.
 *
 * ── NOTHING A CAMPUS COULD REACH BEFORE BECOMES UNREACHABLE ─────────────────
 * The plan grid is new. A campus on `free` today has been using Finance,
 * Documents and Exams for months, because until now every campus had
 * everything. Every module the target tier does not include is therefore
 * GRANDFATHERED: an explicit `setBy: 'admin'` override at `enabled`, permanent,
 * carrying a reason that says where it came from. From there the ADMIN removes
 * them one at a time, deliberately — which is the upsell conversation the
 * system exists to make possible (§13.2, act 6).
 *
 * `ai` IS THE ONE EXCEPTION, and it matters. It is the only module that already
 * carried a per-campus subscription flag, so its past usage is a fact rather
 * than an assumption — and it is the only one that spends money per request.
 * Grandfathering it like the other 25 would hand a paid module to the entire
 * estate; it therefore follows `aiEntitlement.enabled` alone.
 */

const {
  FEATURE_PLANS,
  FEATURE_STATES,
  FEATURE_KEYS,
  PLAN_PRESETS,
} = require('../../constants/features.constants');
const { legacyAiState, aiPlanOf, aiFeatureDeviations, AI_FEATURE_KEY } = require('./entitlement.ai');

/** Reason stamped on every grandfathered override, so its origin is readable. */
const GRANDFATHER_REASON =
  'Grandfathered on migration to the entitlement system — module in use beforehand';

/** Reason stamped on the `ai` override, which is derived rather than grandfathered. */
const AI_REASON = 'Carried over from the campus AI subscription';

/**
 * Target tier for one campus. The AI grid and the module grid share one
 * vocabulary by decision D-D, so an existing `aiEntitlement.plan` IS the tier —
 * one commercial grid, never two.
 *
 * @param {Object|null|undefined} campus
 * @param {string} [override] - Explicit tier, for a bulk decision (`--plan=`).
 * @returns {string} one of FEATURE_PLANS
 */
const targetPlan = (campus, override) => {
  if (override) return override;
  const aiPlan = campus?.aiEntitlement?.plan;
  return Object.values(FEATURE_PLANS).includes(aiPlan) ? aiPlan : FEATURE_PLANS.FREE;
};

/**
 * Builds the entitlement value for one campus from whatever legacy state it
 * carries. Pure: no I/O, no clock of its own.
 *
 * @param {Object} campus - Raw campus document (`features`, `aiEntitlement`).
 * @param {Object} [options]
 * @param {string} [options.plan]   - Tier override; defaults to the AI tier.
 * @param {Date}   [options.now]    - Stamp for the generated overrides.
 * @param {string} [options.actorId]- Who triggered the fold; null for the script.
 * @returns {Object} the entitlement object to store.
 */
const foldLegacyEntitlement = (campus, { plan: planOverride, now = new Date(), actorId = null } = {}) => {
  const plan    = targetPlan(campus, planOverride);
  const granted = PLAN_PRESETS[plan] || [];
  const legacy  = campus?.features || {};
  const ai      = campus?.aiEntitlement || {};

  const override = (key, state, reason) => ({
    key, state, until: null, reason, setBy: 'admin', setAt: now, setById: actorId,
  });

  const modules = FEATURE_KEYS
    .filter((key) => key !== AI_FEATURE_KEY && !granted.includes(key))
    .map((key) => override(key, FEATURE_STATES.ENABLED, GRANDFATHER_REASON));

  // `ai` follows its own subscription flag, and only earns a row when that
  // differs from what the tier already grants (§3 — deviations only).
  const aiState = legacyAiState(ai);
  const aiFromPlan = granted.includes(AI_FEATURE_KEY) ? FEATURE_STATES.ENABLED : FEATURE_STATES.HIDDEN;
  if (aiState !== aiFromPlan) modules.push(override(AI_FEATURE_KEY, aiState, AI_REASON));

  const quotas = {};
  if (legacy.maxStudents          !== undefined) quotas.maxStudents          = legacy.maxStudents;
  if (legacy.maxTeachers          !== undefined) quotas.maxTeachers          = legacy.maxTeachers;
  if (legacy.maxClasses           !== undefined) quotas.maxClasses           = legacy.maxClasses;
  if (legacy.maxDocumentStorageMB !== undefined) quotas.maxDocumentStorageMB = legacy.maxDocumentStorageMB;
  // 0 = unlimited on both sides, so the value carries over verbatim.
  if (ai.monthlyTokenBudget       !== undefined) quotas.aiMonthlyTokens      = ai.monthlyTokenBudget;

  // The AI sub-features are carried as DEVIATIONS from the preset of the tier,
  // never as a full copy: a campus matching its tier stores nothing and follows
  // the grid the day the tier changes.
  const deviations = aiFeatureDeviations(ai.features, aiPlanOf(plan));
  const aiConfig = { llmProfile: ai.llmProfile || 'free' };
  if (deviations) aiConfig.features = deviations;

  return { plan, modules, quotas, ai: aiConfig };
};

module.exports = {
  GRANDFATHER_REASON,
  AI_REASON,
  targetPlan,
  foldLegacyEntitlement,
};
