'use strict';

/**
 * Phase 2 of `CAMPUS_ENTITLEMENT_DESIGN.md` — the AI joins the entitlement grid.
 *
 * What this pins is the seam between two systems that fail in OPPOSITE
 * directions: module entitlement fails open (§4.3, a missing flag must never
 * black out a tenant) while the AI fails closed (it spends money per request).
 * Getting that inversion wrong is not a visible bug — it is an invoice.
 *
 * The strongest assertion here is the ROUND TRIP: folding a legacy campus and
 * resolving the result must yield exactly what the campus could reach before.
 * A migration that changes what a tenant is entitled to is a migration nobody
 * can run twice.
 */

const {
  FEATURE_STATES,
  FEATURE_PLANS,
  PLAN_PRESETS,
} = require('../../shared/constants/features.constants');
const { AI_PLANS, AI_PLAN_PRESETS } = require('../../shared/constants/ai.constants');
const {
  AI_FEATURE_KEY,
  aiPlanOf,
  legacyAiState,
  pickAiFeatures,
  resolveAiEntitlement,
  aiFeatureDeviations,
} = require('../../shared/lib/entitlement/entitlement.ai');
const { foldLegacyEntitlement } = require('../../shared/lib/entitlement/entitlement.legacy');

/** A campus as it exists today: legacy objects, no unified entitlement. */
const legacyCampus = (aiEntitlement = {}, features = {}) => ({
  campus_name: 'Douala',
  status: 'active',
  features,
  aiEntitlement: {
    enabled: false,
    plan: AI_PLANS.FREE,
    llmProfile: 'free',
    monthlyTokenBudget: AI_PLAN_PRESETS[AI_PLANS.FREE].monthlyTokenBudget,
    features: { ...AI_PLAN_PRESETS[AI_PLANS.FREE].features },
    ...aiEntitlement,
  },
});

/** A campus after migration: the unified object only. */
const migratedCampus = (entitlement) => ({
  campus_name: 'Douala', status: 'active', entitlement,
});

const override = (key, state) => ({
  key, state, until: null, reason: 'test', setBy: 'admin', setAt: new Date(),
});

describe('the AI does not fail open', () => {
  it('answers "not subscribed" for a campus that carries nothing at all', () => {
    // The module resolver would say ENABLED here. The AI must not: absence of
    // data can switch a module on, never spend.
    expect(resolveAiEntitlement(null).enabled).toBe(false);
    expect(resolveAiEntitlement({}).enabled).toBe(false);
  });

  it('reads the legacy flag while the campus is not migrated', () => {
    expect(resolveAiEntitlement(legacyCampus({ enabled: false })).enabled).toBe(false);
    expect(resolveAiEntitlement(legacyCampus({ enabled: true })).enabled).toBe(true);
  });

  it('never grandfathers the AI on migration — the one module with a real subscription flag', () => {
    const folded = foldLegacyEntitlement(legacyCampus({ enabled: false }));
    // Every other module outside the tier IS grandfathered…
    expect(folded.modules.some((m) => m.key === 'finance')).toBe(true);
    // …but the AI follows its own flag, and `free` does not include it, so no
    // row is needed at all: the preset already hides it.
    expect(folded.modules.some((m) => m.key === AI_FEATURE_KEY)).toBe(false);
    expect(resolveAiEntitlement(migratedCampus(folded)).enabled).toBe(false);
  });

  it('writes an explicit refusal when the tier grants the AI but the campus never subscribed', () => {
    const folded = foldLegacyEntitlement(legacyCampus({ enabled: false, plan: AI_PLANS.PREMIUM }));
    expect(PLAN_PRESETS[FEATURE_PLANS.PREMIUM]).toContain(AI_FEATURE_KEY);
    expect(folded.modules).toContainEqual(
      expect.objectContaining({ key: AI_FEATURE_KEY, state: FEATURE_STATES.HIDDEN })
    );
    expect(resolveAiEntitlement(migratedCampus(folded)).enabled).toBe(false);
  });
});

describe('the migration changes nothing a campus could reach', () => {
  const cases = [
    ['unsubscribed on free', { enabled: false }],
    ['subscribed on free', { enabled: true }],
    ['subscribed on standard', { enabled: true, plan: AI_PLANS.STANDARD }],
    ['subscribed on premium with a paid profile', {
      enabled: true, plan: AI_PLANS.PREMIUM, llmProfile: 'gpt-4o-mini',
    }],
    ['unlimited budget', { enabled: true, monthlyTokenBudget: 0 }],
    ['a feature bought outside the tier', {
      enabled: true,
      plan: AI_PLANS.STANDARD,
      features: { chat: true, search: true, analytics: true, advisors: true },
    }],
  ];

  it.each(cases)('round-trips: %s', (_label, aiEntitlement) => {
    const campus = legacyCampus(aiEntitlement);
    const before = resolveAiEntitlement(campus);
    const after = resolveAiEntitlement(migratedCampus(foldLegacyEntitlement(campus)));

    expect(after.enabled).toBe(before.enabled);
    expect(after.plan).toBe(before.plan);
    expect(after.llmProfile).toBe(before.llmProfile);
    expect(after.monthlyTokenBudget).toBe(before.monthlyTokenBudget);
    expect(after.features).toEqual(before.features);
  });

  it('carries the quotas across, unlimited included', () => {
    const folded = foldLegacyEntitlement(
      legacyCampus({ monthlyTokenBudget: 0 }, { maxStudents: 400, maxDocumentStorageMB: 2048 })
    );
    expect(folded.quotas).toEqual({
      maxStudents: 400, maxDocumentStorageMB: 2048, aiMonthlyTokens: 0,
    });
    // 0 is "unlimited" on both sides — a `||` anywhere on this path would
    // silently re-cap the campus at its preset.
    expect(resolveAiEntitlement(migratedCampus(folded)).monthlyTokenBudget).toBe(0);
  });
});

describe('the unified object is the only truth once it exists', () => {
  it('a hidden `ai` module unsubscribes the campus', () => {
    const campus = migratedCampus({
      plan: FEATURE_PLANS.PREMIUM, modules: [override(AI_FEATURE_KEY, FEATURE_STATES.HIDDEN)],
    });
    expect(resolveAiEntitlement(campus).enabled).toBe(false);
  });

  it('a frozen `ai` module stays subscribed — the generic gate owns the write refusal', () => {
    // read_only must keep GET /usage and the history reachable; duplicating the
    // method rule here would give it two owners that can disagree.
    const campus = migratedCampus({
      plan: FEATURE_PLANS.PREMIUM, modules: [override(AI_FEATURE_KEY, FEATURE_STATES.READ_ONLY)],
    });
    expect(resolveAiEntitlement(campus).enabled).toBe(true);
  });

  it('ignores the legacy object entirely, so a stale field cannot outlive it', () => {
    const campus = {
      ...migratedCampus({ plan: FEATURE_PLANS.PREMIUM, modules: [] }),
      aiEntitlement: { enabled: false, plan: AI_PLANS.FREE, llmProfile: 'stale', monthlyTokenBudget: 7 },
    };
    const view = resolveAiEntitlement(campus);
    expect(view.enabled).toBe(true);            // premium grants `ai`
    expect(view.plan).toBe(AI_PLANS.PREMIUM);
    expect(view.llmProfile).toBe('free');       // the stale profile is not read
    expect(view.monthlyTokenBudget).toBe(AI_PLAN_PRESETS[AI_PLANS.PREMIUM].monthlyTokenBudget);
  });

  it('merges stored deviations onto the plan preset instead of replacing it', () => {
    const campus = migratedCampus({
      plan: FEATURE_PLANS.STANDARD, modules: [], ai: { features: { advisors: true } },
    });
    expect(resolveAiEntitlement(campus).features).toEqual({
      ...AI_PLAN_PRESETS[AI_PLANS.STANDARD].features,
      advisors: true,
    });
  });

  it('reads the activation date off the override rather than a second field', () => {
    const setAt = new Date('2026-08-20T10:00:00Z');
    const campus = migratedCampus({
      plan: FEATURE_PLANS.FREE,
      modules: [{ ...override(AI_FEATURE_KEY, FEATURE_STATES.ENABLED), setAt }],
    });
    expect(resolveAiEntitlement(campus).activatedAt).toEqual(setAt);
  });
});

describe('what travels to ai-service is narrowed, never forwarded verbatim', () => {
  it('falls back to the least-granting tier for a bespoke module offer', () => {
    // `custom` is a MODULE notion; ai-service knows three plans and must not be
    // handed a fourth to interpret.
    expect(aiPlanOf(FEATURE_PLANS.CUSTOM)).toBe(AI_PLANS.FREE);
    expect(aiPlanOf(undefined)).toBe(AI_PLANS.FREE);
    expect(aiPlanOf('nonsense')).toBe(AI_PLANS.FREE);
    expect(aiPlanOf(AI_PLANS.PREMIUM)).toBe(AI_PLANS.PREMIUM);
  });

  it('drops unknown keys and non-booleans from a stored feature set', () => {
    expect(pickAiFeatures({ chat: true, advisors: 'true', shell: true, search: false }))
      .toEqual({ chat: true, search: false });
    expect(pickAiFeatures(null)).toEqual({});
  });

  it('maps the legacy flag to a module state', () => {
    expect(legacyAiState({ enabled: true })).toBe(FEATURE_STATES.ENABLED);
    expect(legacyAiState({ enabled: false })).toBe(FEATURE_STATES.HIDDEN);
    expect(legacyAiState(undefined)).toBe(FEATURE_STATES.HIDDEN);
  });
});

describe('only the deviations are stored (§3)', () => {
  it('stores nothing when the feature set matches its tier', () => {
    expect(aiFeatureDeviations(AI_PLAN_PRESETS[AI_PLANS.STANDARD].features, AI_PLANS.STANDARD))
      .toBeNull();
  });

  it('stores the single flag that differs, not the whole set', () => {
    expect(aiFeatureDeviations(
      { ...AI_PLAN_PRESETS[AI_PLANS.STANDARD].features, advisors: true },
      AI_PLANS.STANDARD
    )).toEqual({ advisors: true });
  });

  it('re-evaluates against the NEW tier, so an upgrade drops the deviation', () => {
    // advisors:true deviates from `standard` but IS `premium`. Storing it after
    // an upgrade would freeze a copy of the old tier onto the campus.
    expect(aiFeatureDeviations(
      { ...AI_PLAN_PRESETS[AI_PLANS.PREMIUM].features },
      AI_PLANS.PREMIUM
    )).toBeNull();
  });
});
