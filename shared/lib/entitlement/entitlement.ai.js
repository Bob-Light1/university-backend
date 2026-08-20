'use strict';

/**
 * @file entitlement.ai.js
 * @description The AI module's view of the unified per-campus entitlement —
 * phase 2 of `docs/architecture/CAMPUS_ENTITLEMENT_DESIGN.md` (§10).
 *
 * The AI stops carrying its own subscription object and becomes a module like
 * the others FOR ACTIVATION, while keeping what is genuinely specific to it:
 * the token budget, the LLM profile and the four sub-features.
 *
 * | AI concept          | unified source                        |
 * |---------------------|---------------------------------------|
 * | subscribed          | `entitlement.modules` → state of `ai`  |
 * | plan                | `entitlement.plan` (one grid, D-D)     |
 * | monthly token budget| `entitlement.quotas.aiMonthlyTokens`   |
 * | LLM profile         | `entitlement.ai.llmProfile`            |
 * | chat/search/…       | `entitlement.ai.features`, else the plan preset |
 *
 * Output shape is IDENTICAL to the legacy `Campus.aiEntitlement`
 * (`{ enabled, plan, llmProfile, monthlyTokenBudget, features }`), so the gate,
 * the S2S token builder, the admin console and the frontend dialog keep their
 * contract untouched — the acceptance criterion of the phase.
 *
 * ── TWO INVERSIONS OF THE HOUSE ENTITLEMENT RULE, BOTH DELIBERATE ────────────
 *
 * 1. **The AI does not fail open.** `resolveEntitlement()` answers ENABLED for a
 *    campus carrying no entitlement (§4.3) because a missing flag must never
 *    black out a tenant. The AI is the one module where that reasoning inverts:
 *    it spends money per request against a third-party provider. So while a
 *    campus has not been migrated, the AI keeps reading the legacy
 *    `aiEntitlement.enabled` — which defaults to `false`. Absence of data can
 *    switch a module ON; it can never switch SPEND on.
 *
 * 2. **The legacy object is read, not guessed.** `features`/`aiEntitlement` stay
 *    in the schema until the migration is validated in production (§3.2), so a
 *    campus is either migrated (the unified object is the only truth) or not
 *    (the legacy object is). Never a mix: reading half of each would let a
 *    stale field outlive the decision that replaced it. The day §3.2 lands,
 *    every `legacy` branch below disappears and nothing else moves.
 */

const { FEATURE_STATES } = require('../../constants/features.constants');
const {
  AI_PLANS,
  AI_FEATURES,
  AI_PLAN_PRESETS,
} = require('../../constants/ai.constants');
const { resolveEntitlement, getFeatureState } = require('../../utils/entitlement');

/** Registry key governing whether the AI module exists for a campus at all. */
const AI_FEATURE_KEY = 'ai';

/** Fallback LLM profile — the zero-cost one, never a paid profile by default (ADR-5). */
const DEFAULT_LLM_PROFILE = 'free';

const AI_PLAN_VALUES = Object.freeze(Object.values(AI_PLANS));
const AI_FEATURE_VALUES = Object.freeze(Object.values(AI_FEATURES));

/**
 * Narrows a platform tier to an AI tier.
 *
 * The two grids share their vocabulary by decision D-D, with one exception:
 * `custom` exists for a bespoke MODULE offer and says nothing about an AI tier.
 * It must not travel into the S2S JWT, where ai-service knows three plans and
 * would have to guess — so a custom offer falls back to `free`, the tier that
 * grants the least. An explicit AI tier is set by giving the campus one.
 *
 * @param {string|null|undefined} plan
 * @returns {string} one of AI_PLANS
 */
const aiPlanOf = (plan) =>
  (AI_PLAN_VALUES.includes(plan) ? plan : AI_PLANS.FREE);

/**
 * The `ai` module state a legacy campus is entitled to.
 *
 * The AI is the ONLY module that already carried a per-campus subscription flag
 * before this system existed, so it is the only one whose past usage is a fact
 * rather than an assumption. Both the read path (a campus not yet migrated) and
 * `scripts/migrate-entitlement.js` (the campus being migrated) answer the
 * question here, once — grandfathering it like the other 25 modules would hand
 * a paid module to the entire estate.
 *
 * @param {Object|null|undefined} legacy - `Campus.aiEntitlement`.
 * @returns {string} FEATURE_STATES.ENABLED | FEATURE_STATES.HIDDEN
 */
const legacyAiState = (legacy) =>
  (legacy?.enabled ? FEATURE_STATES.ENABLED : FEATURE_STATES.HIDDEN);

/**
 * Keeps only the four declared AI sub-features, and only booleans.
 *
 * Stored deviations are validated on the way in, but this value ends up in the
 * S2S JWT: an unknown flag surviving a schema change, or a `"true"` string,
 * would be handed verbatim to ai-service. Filtering here costs nothing and
 * makes the wire contract independent of what the database happens to hold.
 *
 * @param {Object|null|undefined} features
 * @returns {Object} sanitised subset — possibly empty.
 */
const pickAiFeatures = (features) => {
  if (!features || typeof features !== 'object') return {};
  const picked = {};
  for (const key of AI_FEATURE_VALUES) {
    if (typeof features[key] === 'boolean') picked[key] = features[key];
  }
  return picked;
};

/**
 * Builds the AI entitlement context of one campus from whichever source that
 * campus actually carries.
 *
 * @param {Object|null|undefined} campus - Lean campus document carrying
 *   `entitlement` and/or `aiEntitlement` (see `getCampusAiEntitlement`).
 * @returns {{enabled: boolean, plan: string, llmProfile: string,
 *   monthlyTokenBudget: number, features: Object, migrated: boolean,
 *   activatedAt: Date|null}} frozen — it is shared as `req.aiEntitlement`.
 */
const resolveAiEntitlement = (campus) => {
  const raw = campus?.entitlement || null;
  const legacy = campus?.aiEntitlement || null;
  const migrated = Boolean(raw);

  const resolved = migrated ? resolveEntitlement(raw) : null;
  const plan = aiPlanOf(migrated ? resolved.plan : legacy?.plan);
  const preset = AI_PLAN_PRESETS[plan];

  // Frozen (`read_only`) still counts as subscribed: the generic gate already
  // refuses every mutation on `/api/ai` in that state (§7.1), so re-deciding it
  // here would give the same rule two owners. Only `hidden` unsubscribes.
  const enabled = migrated
    ? getFeatureState(resolved, AI_FEATURE_KEY) !== FEATURE_STATES.HIDDEN
    : Boolean(legacy?.enabled);

  const budget = migrated ? resolved.quotas?.aiMonthlyTokens : legacy?.monthlyTokenBudget;
  const profile = migrated ? resolved.ai?.llmProfile : legacy?.llmProfile;
  const deviations = migrated ? resolved.ai?.features : legacy?.features;

  return Object.freeze({
    enabled,
    plan,
    llmProfile: profile || DEFAULT_LLM_PROFILE,
    // `0` means unlimited on both sides, so the coalescing must be nullish —
    // `||` would silently upgrade an unlimited budget to the preset's ceiling.
    monthlyTokenBudget: Number.isFinite(budget) ? budget : preset.monthlyTokenBudget,
    // The plan preset is the base; only the deviations are stored (§3).
    features: Object.freeze({ ...preset.features, ...pickAiFeatures(deviations) }),
    /** Which side answered — the admin console shows the campus as provisioned or not. */
    migrated,
    /**
     * When the AI was switched on for this campus. Under the unified object the
     * fact is no longer a field of its own: the `ai` override records who
     * decided and when, so it is read from there rather than maintained twice.
     */
    activatedAt: (migrated
      ? (raw.modules || []).find((m) => m.key === AI_FEATURE_KEY)?.setAt
      : legacy?.activatedAt) || null,
  });
};

/**
 * The AI sub-features worth STORING for a given plan: the deviations only.
 *
 * A campus whose feature set matches its tier stores nothing, so a later plan
 * change moves it with the grid instead of dragging a frozen copy of the old
 * tier behind it (§3 — the array holds deviations, never the preset).
 *
 * @param {Object} features - Full desired set.
 * @param {string} plan     - Tier the set is compared against.
 * @returns {Object|null} deviations, or null when there are none.
 */
const aiFeatureDeviations = (features, plan) => {
  const preset = AI_PLAN_PRESETS[aiPlanOf(plan)].features;
  const picked = pickAiFeatures(features);
  const deviations = {};
  for (const [key, value] of Object.entries(picked)) {
    if (preset[key] !== value) deviations[key] = value;
  }
  return Object.keys(deviations).length ? deviations : null;
};

module.exports = {
  AI_FEATURE_KEY,
  DEFAULT_LLM_PROFILE,
  aiPlanOf,
  legacyAiState,
  pickAiFeatures,
  resolveAiEntitlement,
  aiFeatureDeviations,
};
