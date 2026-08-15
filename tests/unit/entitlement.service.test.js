'use strict';

/**
 * `shared/lib/entitlement/entitlement.service.js` — the only code path that
 * reads or writes a campus entitlement (design doc phase 1).
 *
 * The campus facade is stubbed; everything else — resolver, guard, cache,
 * pruning — is real. What this pins is the part no other suite covers: what is
 * actually STORED after a change, and what is invalidated afterwards.
 *
 *   - only the deviations are stored (§3): a redundant override is a decision
 *     nobody made that would silently survive the next plan change;
 *   - the two layers write side by side without overwriting each other, which
 *     is the whole point of having two of them (§5);
 *   - every mutation appends an audit row and drops the cache entry — both in
 *     the service, so a future route cannot forget either (§7.2, CLAUDE.md §8).
 */

const {
  FEATURE_STATES,
  FEATURE_PLANS,
} = require('../../shared/constants/features.constants');
const { OVERRIDE_LAYERS } = require('../../shared/utils/entitlement');

// `mock`-prefixed so jest allows the factory below to close over it.
const mockCampusFacade = {
  getCampusEntitlement: jest.fn(),
  setCampusEntitlement: jest.fn(),
};

jest.mock('../../modules/campus', () => ({ service: mockCampusFacade }));

// The probes hit real collections; the decision logic they feed is pinned in
// tests/unit/entitlement-deps.test.js.
jest.mock('../../shared/lib/entitlement/entitlement.usage', () => ({
  findUsageBlockers: jest.fn().mockResolvedValue([]),
  findRecordBlockers: jest.fn().mockResolvedValue([]),
}));

const service = require('../../shared/lib/entitlement/entitlement.service');
const cache = require('../../shared/lib/entitlement/entitlement.cache');
const { findUsageBlockers } = require('../../shared/lib/entitlement/entitlement.usage');

const CAMPUS_ID = '507f1f77bcf86cd799439012';
const ACTOR = { id: '507f1f77bcf86cd799439011', role: 'ADMIN' };

/** Makes the stored campus look like `entitlement`. */
const storedAs = (entitlement) => {
  mockCampusFacade.getCampusEntitlement.mockResolvedValue({
    _id: CAMPUS_ID, campus_name: 'Douala', entitlement,
  });
  mockCampusFacade.setCampusEntitlement.mockImplementation(async (_id, next) => ({
    campus_name: 'Douala', entitlement: next,
  }));
};

/** The entitlement object handed to the repository by the last write. */
const written = () => mockCampusFacade.setCampusEntitlement.mock.calls.at(-1)[1];
const auditRow = () => mockCampusFacade.setCampusEntitlement.mock.calls.at(-1)[2];

beforeEach(() => {
  jest.clearAllMocks();
  cache.clear();
  findUsageBlockers.mockResolvedValue([]);
  storedAs({ plan: FEATURE_PLANS.STANDARD, modules: [] });
});

describe('resolveForCampus — caching (§7.2)', () => {
  it('reads the campus once and serves the rest from memory', async () => {
    await service.resolveForCampus(CAMPUS_ID);
    await service.resolveForCampus(CAMPUS_ID);
    await service.resolveForCampus(CAMPUS_ID);
    expect(mockCampusFacade.getCampusEntitlement).toHaveBeenCalledTimes(1);
  });

  it('re-reads after the entry is dropped', async () => {
    await service.resolveForCampus(CAMPUS_ID);
    cache.bump(CAMPUS_ID);
    await service.resolveForCampus(CAMPUS_ID);
    expect(mockCampusFacade.getCampusEntitlement).toHaveBeenCalledTimes(2);
  });

  it('falls open when the campus cannot be read at all', async () => {
    mockCampusFacade.getCampusEntitlement.mockResolvedValue(null);
    const resolved = await service.resolveForCampus(CAMPUS_ID);
    expect(resolved.features.gaet).toBe(FEATURE_STATES.ENABLED);
  });
});

describe('applyChanges — what actually gets stored', () => {
  it('stores only the deviation, never what the plan already grants (§3)', async () => {
    await service.applyChanges({
      campusId: CAMPUS_ID, layer: OVERRIDE_LAYERS.ADMIN, actor: ACTOR,
      modules: [
        { key: 'gaet', state: FEATURE_STATES.ENABLED, reason: 'pilot for the new term' },
        // `finance` is already enabled on `standard`: redundant, must not be kept.
        { key: 'finance', state: FEATURE_STATES.ENABLED, reason: 'no change at all' },
      ],
    });

    expect(written().modules.map((m) => m.key)).toEqual(['gaet']);
  });

  it('keeps a redundant override when it carries an `until` — that is a statement about the future', async () => {
    const until = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    await service.applyChanges({
      campusId: CAMPUS_ID, layer: OVERRIDE_LAYERS.ADMIN, actor: ACTOR,
      modules: [{ key: 'finance', state: FEATURE_STATES.ENABLED, until, reason: 'pilot until March' }],
    });
    expect(written().modules.map((m) => m.key)).toEqual(['finance']);
  });

  it('replaces the previous override of the SAME layer instead of stacking one more', async () => {
    storedAs({
      plan: FEATURE_PLANS.STANDARD,
      modules: [{ key: 'announcement', state: FEATURE_STATES.READ_ONLY, until: null, reason: 'first', setBy: 'campus' }],
    });

    await service.applyChanges({
      campusId: CAMPUS_ID, layer: OVERRIDE_LAYERS.CAMPUS, actor: ACTOR,
      modules: [{ key: 'announcement', state: FEATURE_STATES.HIDDEN, reason: 'second decision, same layer' }],
    });

    const rows = written().modules.filter((m) => m.key === 'announcement');
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe(FEATURE_STATES.HIDDEN);
  });

  it('leaves the OTHER layer\'s override untouched — the two coexist by design (§5)', async () => {
    storedAs({
      plan: FEATURE_PLANS.FREE,
      modules: [{ key: 'finance', state: FEATURE_STATES.ENABLED, until: null, reason: 'sold', setBy: 'admin' }],
    });

    await service.applyChanges({
      campusId: CAMPUS_ID, layer: OVERRIDE_LAYERS.CAMPUS, actor: ACTOR,
      modules: [{ key: 'finance', state: FEATURE_STATES.READ_ONLY, reason: 'freeze during the audit' }],
    });

    const byLayer = Object.fromEntries(written().modules.map((m) => [m.setBy, m.state]));
    expect(byLayer).toEqual({
      admin: FEATURE_STATES.ENABLED,       // the offer stands
      campus: FEATURE_STATES.READ_ONLY,    // the manager restricts inside it
    });
  });

  it('stamps who decided and when — a disappeared button needs a why', async () => {
    await service.applyChanges({
      campusId: CAMPUS_ID, layer: OVERRIDE_LAYERS.ADMIN, actor: ACTOR,
      modules: [{ key: 'gaet', state: FEATURE_STATES.ENABLED, reason: 'upsell agreed on 2026-08-15' }],
    });

    expect(written().modules[0]).toMatchObject({
      setBy: 'admin', setById: ACTOR.id, reason: 'upsell agreed on 2026-08-15',
    });
    expect(auditRow()).toMatchObject({ actorId: ACTOR.id, actorRole: 'ADMIN' });
    expect(auditRow().changes.modules[0].key).toBe('gaet');
  });

  it('records the plan on the audit row when the offer layer changes it', async () => {
    await service.applyChanges({
      campusId: CAMPUS_ID, layer: OVERRIDE_LAYERS.ADMIN, actor: ACTOR, plan: FEATURE_PLANS.PREMIUM,
    });
    expect(written().plan).toBe(FEATURE_PLANS.PREMIUM);
    expect(auditRow().changes.plan).toBe(FEATURE_PLANS.PREMIUM);
  });

  it('ignores a plan submitted on the usage layer — a manager does not set their own tier', async () => {
    await service.applyChanges({
      campusId: CAMPUS_ID, layer: OVERRIDE_LAYERS.CAMPUS, actor: ACTOR, plan: FEATURE_PLANS.PREMIUM,
      modules: [{ key: 'mentor', state: FEATURE_STATES.HIDDEN, reason: 'not used on this campus' }],
    });
    expect(written().plan).toBe(FEATURE_PLANS.STANDARD);
    expect(auditRow().changes.plan).toBeUndefined();
  });

  it('drops the cache entry so the next request sees the change', async () => {
    await service.resolveForCampus(CAMPUS_ID);
    expect(cache.get(CAMPUS_ID)).not.toBeNull();

    await service.applyChanges({
      campusId: CAMPUS_ID, layer: OVERRIDE_LAYERS.ADMIN, actor: ACTOR,
      modules: [{ key: 'gaet', state: FEATURE_STATES.ENABLED, reason: 'upsell agreed today' }],
    });
    expect(cache.get(CAMPUS_ID)).toBeNull();
  });
});

describe('applyChanges — refusals write nothing', () => {
  it('refuses a core module and leaves the stored value alone', async () => {
    const result = await service.applyChanges({
      campusId: CAMPUS_ID, layer: OVERRIDE_LAYERS.ADMIN, actor: ACTOR,
      modules: [{ key: 'settings', state: FEATURE_STATES.HIDDEN, reason: 'nobody uses the settings' }],
    });

    expect(result.ok).toBe(false);
    expect(result.blockers[0].code).toBe('FEATURE_CORE');
    expect(mockCampusFacade.setCampusEntitlement).not.toHaveBeenCalled();
  });

  it('refuses a campus override that widens the offer', async () => {
    const result = await service.applyChanges({
      campusId: CAMPUS_ID, layer: OVERRIDE_LAYERS.CAMPUS, actor: ACTOR,
      modules: [{ key: 'gaet', state: FEATURE_STATES.ENABLED, reason: 'we would like GAET please' }],
    });

    expect(result.ok).toBe(false);
    expect(result.blockers[0].code).toBe('FEATURE_NOT_IN_OFFER');
    expect(mockCampusFacade.setCampusEntitlement).not.toHaveBeenCalled();
  });

  it('refuses to hide a module the data still needs, and says which collection blocks it', async () => {
    findUsageBlockers.mockResolvedValue([{ model: 'Result', label: 'Results' }]);

    const result = await service.applyChanges({
      campusId: CAMPUS_ID, layer: OVERRIDE_LAYERS.ADMIN, actor: ACTOR,
      modules: [{ key: 'subject', state: FEATURE_STATES.HIDDEN, reason: 'subjects are managed elsewhere' }],
    });

    expect(result.ok).toBe(false);
    expect(result.blockers[0].code).toBe('FEATURE_IN_USE');
    expect(result.blockers[0].blockedBy).toEqual(['Results']);
    expect(mockCampusFacade.setCampusEntitlement).not.toHaveBeenCalled();
  });

  it('reports a campus that does not exist rather than creating an entitlement for it', async () => {
    mockCampusFacade.getCampusEntitlement.mockResolvedValue(null);
    const result = await service.applyChanges({
      campusId: CAMPUS_ID, layer: OVERRIDE_LAYERS.ADMIN, actor: ACTOR,
      modules: [{ key: 'gaet', state: FEATURE_STATES.ENABLED, reason: 'upsell agreed today' }],
    });
    expect(result.notFound).toBe(true);
    expect(mockCampusFacade.setCampusEntitlement).not.toHaveBeenCalled();
  });
});

describe('describeForCampus — the pilot screen payload', () => {
  it('separates the effective state from the offer ceiling and from the plan alone', async () => {
    storedAs({
      plan: FEATURE_PLANS.FREE,
      modules: [
        { key: 'finance', state: FEATURE_STATES.ENABLED, until: null, reason: 'sold', setBy: 'admin' },
        { key: 'finance', state: FEATURE_STATES.READ_ONLY, until: null, reason: 'frozen', setBy: 'campus' },
      ],
    });

    const report = await service.describeForCampus(CAMPUS_ID);
    const finance = report.features.find((f) => f.key === 'finance');

    expect(finance.planState).toBe(FEATURE_STATES.HIDDEN);      // not in the free tier
    expect(finance.offerState).toBe(FEATURE_STATES.ENABLED);    // but sold to this campus
    expect(finance.state).toBe(FEATURE_STATES.READ_ONLY);       // and frozen by its manager

    // Both layers are reported side by side: collapsing them into "the
    // override" shows the admin's decision on the manager's screen.
    expect(finance.overrides.admin.state).toBe(FEATURE_STATES.ENABLED);
    expect(finance.overrides.campus.state).toBe(FEATURE_STATES.READ_ONLY);
  });

  it('carries the registry metadata a pilot screen needs', async () => {
    const report = await service.describeForCampus(CAMPUS_ID);
    const result = report.features.find((f) => f.key === 'result');
    expect(result).toMatchObject({ label: 'Results & transcripts', core: false, minState: FEATURE_STATES.READ_ONLY });
  });
});
