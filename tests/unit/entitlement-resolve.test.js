'use strict';

/**
 * shared/utils/entitlement.js — the resolver
 * (docs/architecture/CAMPUS_ENTITLEMENT_DESIGN.md §4.2 / §4.3, phase 1).
 *
 * The resolver is the ONE place the precedence order is written, so this suite
 * pins it exhaustively and without a database — that is the whole reason the
 * function takes raw data and an injected clock.
 *
 * What it guarantees:
 *   - fail-OPEN, deliberately inverted from `buildCampusFilter()` /
 *     `notDeletedFilter()`: no data and no key both mean ENABLED. Getting this
 *     backwards would switch every module off on every tenant on deploy day;
 *   - the two layers do not have the same power — the offer raises and lowers,
 *     the usage layer only ever lowers;
 *   - `until` is data, never a job: an expired override falls back on its own
 *     at read time, with no cron and no state to reconcile;
 *   - `core` wins over everything, so no actor can produce a campus that has to
 *     be repaired by hand in the database.
 */

const {
  FEATURE_STATES,
  FEATURE_PLANS,
  FEATURE_KEYS,
  CORE_FEATURE_KEYS,
  PLAN_PRESETS,
} = require('../../shared/constants/features.constants');

const {
  OVERRIDE_LAYERS,
  ALL_ENABLED,
  isOverrideActive,
  planBaseState,
  resolveEntitlement,
  getFeatureState,
  isFeatureActive,
} = require('../../shared/utils/entitlement');

const NOW = new Date('2026-08-15T12:00:00.000Z');
const LATER = new Date('2026-09-15T12:00:00.000Z');
const EARLIER = new Date('2026-07-15T12:00:00.000Z');

/** One stored override, with the boilerplate filled in. */
const override = (key, state, extra = {}) => ({
  key, state, until: null, reason: '', setBy: OVERRIDE_LAYERS.ADMIN, setAt: NOW, ...extra,
});

const stateOf = (data, key) => getFeatureState(resolveEntitlement(data, { now: NOW }), key);

describe('resolveEntitlement — fail-open (§4.3)', () => {
  it.each([null, undefined, ''])('resolves everything to ENABLED when the campus carries no entitlement (%p)', (data) => {
    const resolved = resolveEntitlement(data, { now: NOW });
    expect(resolved).toBe(ALL_ENABLED);
    for (const key of FEATURE_KEYS) {
      expect(resolved.features[key]).toBe(FEATURE_STATES.ENABLED);
    }
  });

  it('resolves an unregistered key to ENABLED rather than failing the lookup', () => {
    const resolved = resolveEntitlement({ plan: FEATURE_PLANS.FREE }, { now: NOW });
    // A module shipped before its registry entry must stay reachable in
    // production — that is the entire point of the inversion.
    expect(getFeatureState(resolved, 'module-that-does-not-exist-yet')).toBe(FEATURE_STATES.ENABLED);
  });

  it('treats a missing plan as "no tiering at all", not as the free tier', () => {
    // A campus predating the system has data (an override) but no plan. Reading
    // that as `free` would hide every paid module it has been using for months.
    expect(stateOf({ modules: [] }, 'finance')).toBe(FEATURE_STATES.ENABLED);
    expect(stateOf({ plan: FEATURE_PLANS.FREE }, 'finance')).toBe(FEATURE_STATES.HIDDEN);
  });
});

describe('resolveEntitlement — plan presets', () => {
  it('grants exactly the preset of the tier and hides the rest', () => {
    for (const plan of [FEATURE_PLANS.FREE, FEATURE_PLANS.STANDARD, FEATURE_PLANS.PREMIUM]) {
      const resolved = resolveEntitlement({ plan }, { now: NOW });
      for (const key of FEATURE_KEYS) {
        const expected = PLAN_PRESETS[plan].includes(key)
          ? FEATURE_STATES.ENABLED
          : FEATURE_STATES.HIDDEN;
        expect([key, resolved.features[key]]).toEqual([key, expected]);
      }
    }
  });

  it('grants nothing implicitly on `custom` — it is defined by its overrides only', () => {
    const resolved = resolveEntitlement({ plan: FEATURE_PLANS.CUSTOM }, { now: NOW });
    const nonCore = FEATURE_KEYS.filter((k) => !CORE_FEATURE_KEYS.includes(k));
    expect(nonCore.every((k) => resolved.features[k] === FEATURE_STATES.HIDDEN)).toBe(true);
  });

  it('planBaseState agrees with the presets it is derived from', () => {
    expect(planBaseState(FEATURE_PLANS.FREE, 'result')).toBe(FEATURE_STATES.ENABLED);
    expect(planBaseState(FEATURE_PLANS.FREE, 'gaet')).toBe(FEATURE_STATES.HIDDEN);
    expect(planBaseState(FEATURE_PLANS.PREMIUM, 'gaet')).toBe(FEATURE_STATES.ENABLED);
    expect(planBaseState(null, 'gaet')).toBe(FEATURE_STATES.ENABLED);
  });
});

describe('resolveEntitlement — the two layers (§5)', () => {
  it('lets the OFFER layer grant a module the plan does not include (the upsell / grandfathering case)', () => {
    const data = { plan: FEATURE_PLANS.FREE, modules: [override('finance', FEATURE_STATES.ENABLED)] };
    expect(stateOf(data, 'finance')).toBe(FEATURE_STATES.ENABLED);
  });

  it('lets the OFFER layer lower a module the plan does include', () => {
    const data = { plan: FEATURE_PLANS.PREMIUM, modules: [override('gaet', FEATURE_STATES.READ_ONLY)] };
    expect(stateOf(data, 'gaet')).toBe(FEATURE_STATES.READ_ONLY);
  });

  it('lets the USAGE layer restrict inside the offer', () => {
    const data = {
      plan: FEATURE_PLANS.STANDARD,
      modules: [override('announcement', FEATURE_STATES.READ_ONLY, { setBy: OVERRIDE_LAYERS.CAMPUS })],
    };
    expect(stateOf(data, 'announcement')).toBe(FEATURE_STATES.READ_ONLY);
  });

  it('makes a USAGE override that tries to WIDEN inert, never effective', () => {
    // The guard refuses this at write time; the resolver must also be safe on
    // a row already in the database — otherwise a stale entry sells a premium
    // module for free.
    const data = {
      plan: FEATURE_PLANS.FREE,
      modules: [override('gaet', FEATURE_STATES.ENABLED, { setBy: OVERRIDE_LAYERS.CAMPUS })],
    };
    expect(stateOf(data, 'gaet')).toBe(FEATURE_STATES.HIDDEN);
  });

  it('lets the usage layer lower BELOW an admin override, never above it', () => {
    const data = {
      plan: FEATURE_PLANS.FREE,
      modules: [
        override('finance', FEATURE_STATES.ENABLED),
        override('finance', FEATURE_STATES.READ_ONLY, { setBy: OVERRIDE_LAYERS.CAMPUS }),
      ],
    };
    expect(stateOf(data, 'finance')).toBe(FEATURE_STATES.READ_ONLY);

    const widening = {
      plan: FEATURE_PLANS.FREE,
      modules: [
        override('finance', FEATURE_STATES.READ_ONLY),
        override('finance', FEATURE_STATES.ENABLED, { setBy: OVERRIDE_LAYERS.CAMPUS }),
      ],
    };
    expect(stateOf(widening, 'finance')).toBe(FEATURE_STATES.READ_ONLY);
  });
});

describe('resolveEntitlement — expiry is read, never scheduled (§4.2)', () => {
  it('honours an override whose `until` is still ahead', () => {
    const data = {
      plan: FEATURE_PLANS.FREE,
      modules: [override('finance', FEATURE_STATES.ENABLED, { until: LATER })],
    };
    expect(stateOf(data, 'finance')).toBe(FEATURE_STATES.ENABLED);
  });

  it('drops an expired override back to the layer underneath, with no cron involved', () => {
    const data = {
      plan: FEATURE_PLANS.FREE,
      modules: [override('finance', FEATURE_STATES.ENABLED, { until: EARLIER })],
    };
    expect(stateOf(data, 'finance')).toBe(FEATURE_STATES.HIDDEN);
  });

  it('returns the same row as active before and inert after its date, from the data alone', () => {
    const row = override('announcement', FEATURE_STATES.READ_ONLY, { until: LATER });
    expect(isOverrideActive(row, NOW)).toBe(true);
    expect(isOverrideActive(row, new Date('2026-10-01T00:00:00.000Z'))).toBe(false);
  });

  it('ignores a malformed override instead of letting it decide anything', () => {
    expect(isOverrideActive(null, NOW)).toBe(false);
    expect(isOverrideActive({ key: 'nope', state: 'enabled' }, NOW)).toBe(false);
    expect(isOverrideActive({ key: 'finance', state: 'turbo' }, NOW)).toBe(false);
  });
});

describe('resolveEntitlement — the core floor (§5.1)', () => {
  it.each(CORE_FEATURE_KEYS)('forces %s back to ENABLED whatever anyone wrote', (key) => {
    const data = {
      plan: FEATURE_PLANS.CUSTOM,
      modules: [
        override(key, FEATURE_STATES.HIDDEN),
        override(key, FEATURE_STATES.HIDDEN, { setBy: OVERRIDE_LAYERS.CAMPUS }),
      ],
    };
    expect(stateOf(data, key)).toBe(FEATURE_STATES.ENABLED);
  });

  it('keeps `settings` reachable on every tier — it hosts the screen that switches things back on', () => {
    for (const plan of Object.values(FEATURE_PLANS)) {
      expect(stateOf({ plan }, 'settings')).toBe(FEATURE_STATES.ENABLED);
    }
  });
});

describe('isFeatureActive — read vs write (§4.1)', () => {
  const frozen = resolveEntitlement(
    { plan: FEATURE_PLANS.STANDARD, modules: [override('announcement', FEATURE_STATES.READ_ONLY)] },
    { now: NOW }
  );

  it('serves reads and refuses writes on a frozen module — the history survives', () => {
    expect(isFeatureActive(frozen, 'announcement')).toBe(true);
    expect(isFeatureActive(frozen, 'announcement', { write: true })).toBe(false);
  });

  it('refuses both on a hidden module', () => {
    const hidden = resolveEntitlement({ plan: FEATURE_PLANS.FREE }, { now: NOW });
    expect(isFeatureActive(hidden, 'gaet')).toBe(false);
    expect(isFeatureActive(hidden, 'gaet', { write: true })).toBe(false);
  });

  it('allows both on an unknown key (fail-open reaches the gate too)', () => {
    const resolved = resolveEntitlement({ plan: FEATURE_PLANS.FREE }, { now: NOW });
    expect(isFeatureActive(resolved, 'brand-new-module', { write: true })).toBe(true);
  });
});

describe('resolveEntitlement — output contract', () => {
  it('freezes its result: it is shared through the cache and must not be mutated', () => {
    const resolved = resolveEntitlement({ plan: FEATURE_PLANS.FREE }, { now: NOW });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.features)).toBe(true);
  });

  it('carries quotas and the AI leftover through untouched', () => {
    const resolved = resolveEntitlement(
      { plan: FEATURE_PLANS.FREE, quotas: { maxStudents: 42 }, ai: { llmProfile: 'paid' } },
      { now: NOW }
    );
    expect(resolved.quotas).toEqual({ maxStudents: 42 });
    expect(resolved.ai).toEqual({ llmProfile: 'paid' });
  });

  it('never reads the clock on its own — the same data resolves differently at two injected times', () => {
    const data = {
      plan: FEATURE_PLANS.FREE,
      modules: [override('finance', FEATURE_STATES.ENABLED, { until: LATER })],
    };
    expect(getFeatureState(resolveEntitlement(data, { now: NOW }), 'finance')).toBe(FEATURE_STATES.ENABLED);
    expect(getFeatureState(resolveEntitlement(data, { now: new Date('2027-01-01') }), 'finance'))
      .toBe(FEATURE_STATES.HIDDEN);
  });
});
