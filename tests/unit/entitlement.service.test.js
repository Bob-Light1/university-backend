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
  listCampusesForEstate: jest.fn(),
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

describe('parsePayload — the value fields the pilot dialog now submits (phase 4)', () => {
  const { parsePayload } = require('../../shared/lib/entitlement/entitlement.controller');

  it('carries quotas and ai through on the offer layer', () => {
    const { errors, values } = parsePayload(
      { quotas: { aiMonthlyTokens: 5000000 }, ai: { llmProfile: 'premium' } },
      true
    );
    expect(errors).toHaveLength(0);
    expect(values).toEqual({ quotas: { aiMonthlyTokens: 5000000 }, ai: { llmProfile: 'premium' } });
  });

  it('refuses them on the usage layer rather than dropping them silently', () => {
    // Same rule as `plan`: a manager who believes they raised their own budget
    // and received a 200 has been told something false about their bill.
    const { errors, values } = parsePayload({ quotas: { maxStudents: 99999 } }, false);
    expect(values).toEqual({});
    expect(errors[0].field).toBe('quotas');
  });

  it('still refuses an empty submission', () => {
    expect(parsePayload({}, true).errors[0].field).toBe('body');
  });

  it('refuses a value field that is not an object', () => {
    expect(parsePayload({ ai: 'premium' }, true).errors[0].field).toBe('ai');
  });
});

describe('describeForCampus — what each layer may actually select', () => {
  it('never offers a restricted state on a core module, to either layer', async () => {
    storedAs({ plan: FEATURE_PLANS.PREMIUM, modules: [] });

    for (const layer of [OVERRIDE_LAYERS.ADMIN, OVERRIDE_LAYERS.CAMPUS]) {
      const report = await service.describeForCampus(CAMPUS_ID, { layer });
      const settings = report.features.find((f) => f.key === 'settings');
      expect(settings.allowedStates).toEqual([FEATURE_STATES.ENABLED]);
    }
  });

  it('lets the offer layer widen, and stops the usage layer at the ceiling (§5)', async () => {
    // Free tier: `gaet` is outside the offer entirely.
    storedAs({ plan: FEATURE_PLANS.FREE, modules: [] });

    const asAdmin = await service.describeForCampus(CAMPUS_ID, { layer: OVERRIDE_LAYERS.ADMIN });
    const asManager = await service.describeForCampus(CAMPUS_ID, { layer: OVERRIDE_LAYERS.CAMPUS });

    // The admin sells it — every state is theirs to set.
    expect(asAdmin.features.find((f) => f.key === 'gaet').allowedStates)
      .toEqual(expect.arrayContaining([FEATURE_STATES.ENABLED, FEATURE_STATES.HIDDEN]));
    // The manager cannot grant themselves a module nobody sold them.
    expect(asManager.features.find((f) => f.key === 'gaet').allowedStates)
      .toEqual([FEATURE_STATES.HIDDEN]);
  });

  it('opens the usage layer exactly as far as the offer override reaches', async () => {
    storedAs({
      plan: FEATURE_PLANS.FREE,
      modules: [{ key: 'finance', state: FEATURE_STATES.READ_ONLY, until: null, reason: 'pilot, frozen', setBy: 'admin' }],
    });

    const report = await service.describeForCampus(CAMPUS_ID, { layer: OVERRIDE_LAYERS.CAMPUS });
    const finance = report.features.find((f) => f.key === 'finance');

    // Sold frozen: the manager may keep it frozen or hide it, never re-open it.
    expect(finance.allowedStates).toEqual([FEATURE_STATES.READ_ONLY, FEATURE_STATES.HIDDEN]);
  });
});

describe('describeEstate — the admin estate matrix (§13.1)', () => {
  const DOUALA = '507f1f77bcf86cd799439012';
  const YAOUNDE = '507f1f77bcf86cd799439013';

  it('lists a campus nobody configured, with every module open', async () => {
    mockCampusFacade.listCampusesForEstate.mockResolvedValue([
      { _id: YAOUNDE, campus_name: 'Yaoundé', status: 'active', entitlement: null },
    ]);

    const { campuses } = await service.describeEstate();

    // The unconfigured tenant is the one with every paid module open (§4.3).
    // Filtering it out — the shape `listCampusEntitlements()` has — would
    // answer "who has what" with only the campuses somebody already touched.
    expect(campuses).toHaveLength(1);
    expect(campuses[0].configured).toBe(false);
    expect(campuses[0].states.gaet).toBe(FEATURE_STATES.ENABLED);
    expect(campuses[0].states.ai).toBe(FEATURE_STATES.ENABLED);
  });

  it('resolves each row on its own entitlement, in one read', async () => {
    mockCampusFacade.listCampusesForEstate.mockResolvedValue([
      {
        _id: DOUALA,
        campus_name: 'Douala',
        status: 'active',
        entitlement: {
          plan: FEATURE_PLANS.STANDARD,
          modules: [{ key: 'announcement', state: FEATURE_STATES.READ_ONLY, until: null, reason: 'to be framed', setBy: 'campus' }],
        },
      },
      { _id: YAOUNDE, campus_name: 'Yaoundé', status: 'archived', entitlement: { plan: FEATURE_PLANS.FREE, modules: [] } },
    ]);

    const { campuses, features } = await service.describeEstate();

    expect(mockCampusFacade.listCampusesForEstate).toHaveBeenCalledTimes(1);
    expect(campuses[0]).toMatchObject({ campusName: 'Douala', plan: FEATURE_PLANS.STANDARD, configured: true });
    expect(campuses[0].states.announcement).toBe(FEATURE_STATES.READ_ONLY);
    expect(campuses[0].states.finance).toBe(FEATURE_STATES.ENABLED);   // in the standard tier
    expect(campuses[1].states.finance).toBe(FEATURE_STATES.HIDDEN);    // not in the free one
    expect(campuses[1].status).toBe('archived');

    // The columns travel with the rows: the matrix draws its header from the
    // registry rather than from a list copied into the frontend (§8.2).
    expect(features.map((f) => f.key)).toEqual(expect.arrayContaining(['finance', 'gaet', 'ai']));
    expect(features.find((f) => f.key === 'settings').core).toBe(true);
  });

  it('reads `until` expiry at the instant it is given, exactly like the gate', async () => {
    const until = new Date('2027-03-31T00:00:00Z');
    mockCampusFacade.listCampusesForEstate.mockResolvedValue([{
      _id: DOUALA,
      campus_name: 'Douala',
      status: 'active',
      entitlement: {
        plan: FEATURE_PLANS.FREE,
        modules: [{ key: 'finance', state: FEATURE_STATES.ENABLED, until, reason: 'pilot T2', setBy: 'admin' }],
      },
    }]);

    const during = await service.describeEstate({ now: new Date('2027-02-01T00:00:00Z') });
    const after = await service.describeEstate({ now: new Date('2027-04-01T00:00:00Z') });

    expect(during.campuses[0].states.finance).toBe(FEATURE_STATES.ENABLED);
    expect(after.campuses[0].states.finance).toBe(FEATURE_STATES.HIDDEN);
  });

  it('never serves a row from the per-campus cache', async () => {
    // A matrix stitched from entries of different ages shows two campuses as
    // of two different moments. One read, one instant.
    await service.resolveForCampus(DOUALA);
    mockCampusFacade.listCampusesForEstate.mockResolvedValue([
      { _id: DOUALA, campus_name: 'Douala', status: 'active', entitlement: { plan: FEATURE_PLANS.FREE, modules: [] } },
    ]);

    const { campuses } = await service.describeEstate();
    expect(campuses[0].plan).toBe(FEATURE_PLANS.FREE);
  });
});

describe('applyChanges — the value fields the AI console writes (phase 2)', () => {
  it('merges a quota patch instead of replacing the block', async () => {
    storedAs({ plan: FEATURE_PLANS.STANDARD, modules: [], quotas: { maxStudents: 400 } });

    await service.applyChanges({
      campusId: CAMPUS_ID, layer: OVERRIDE_LAYERS.ADMIN, actor: ACTOR,
      quotas: { aiMonthlyTokens: 1000000 },
      modules: [{ key: 'gaet', state: FEATURE_STATES.ENABLED, reason: 'upsell agreed today' }],
    });

    // A partial patch is a patch: the quota nobody mentioned must survive it.
    expect(written().quotas).toEqual({ maxStudents: 400, aiMonthlyTokens: 1000000 });
  });

  it('merges one level down, so a single AI flag does not wipe its siblings', async () => {
    storedAs({
      plan: FEATURE_PLANS.STANDARD, modules: [],
      ai: { llmProfile: 'gpt-4o-mini', features: { advisors: true } },
    });

    await service.applyChanges({
      campusId: CAMPUS_ID, layer: OVERRIDE_LAYERS.ADMIN, actor: ACTOR,
      ai: { features: { analytics: false } },
    });

    expect(written().ai).toEqual({
      llmProfile: 'gpt-4o-mini',
      features: { advisors: true, analytics: false },
    });
  });

  it('removes a key on null — that is how a deviation is handed back to the preset', async () => {
    storedAs({
      plan: FEATURE_PLANS.STANDARD, modules: [],
      ai: { llmProfile: 'gpt-4o-mini', features: { advisors: true } },
    });

    await service.applyChanges({
      campusId: CAMPUS_ID, layer: OVERRIDE_LAYERS.ADMIN, actor: ACTOR,
      ai: { features: null },
    });

    expect(written().ai).toEqual({ llmProfile: 'gpt-4o-mini' });
  });

  it('ignores value patches submitted on the usage layer — a manager does not write their own bill', async () => {
    storedAs({ plan: FEATURE_PLANS.STANDARD, modules: [], quotas: { maxStudents: 400 } });

    await service.applyChanges({
      campusId: CAMPUS_ID, layer: OVERRIDE_LAYERS.CAMPUS, actor: ACTOR,
      quotas: { maxStudents: 99999 },
      modules: [{ key: 'mentor', state: FEATURE_STATES.HIDDEN, reason: 'not used on this campus' }],
    });

    expect(written().quotas).toEqual({ maxStudents: 400 });
  });

  it('refuses a patch that is not an object rather than storing it', async () => {
    const result = await service.applyChanges({
      campusId: CAMPUS_ID, layer: OVERRIDE_LAYERS.ADMIN, actor: ACTOR, ai: 'premium',
    });

    expect(result.ok).toBe(false);
    expect(result.blockers[0].code).toBe('FEATURE_PATCH_INVALID');
    expect(mockCampusFacade.setCampusEntitlement).not.toHaveBeenCalled();
  });
});

describe('applyChanges — the first write on a campus the migration has not reached', () => {
  /** A campus as it exists before `scripts/migrate-entitlement.js` has run. */
  const unmigrated = () => {
    mockCampusFacade.getCampusEntitlement.mockResolvedValue({
      _id: CAMPUS_ID,
      campus_name: 'Douala',
      features: { maxStudents: 400 },
      aiEntitlement: { enabled: false, plan: FEATURE_PLANS.FREE, llmProfile: 'free' },
    });
  };

  it('folds the legacy configuration first, so the tier lands with its grandfathering', async () => {
    unmigrated();

    await service.applyChanges({
      campusId: CAMPUS_ID, layer: OVERRIDE_LAYERS.ADMIN, actor: ACTOR,
      ai: { llmProfile: 'gpt-4o-mini' },
    });

    const stored = written();
    // Without the fold this write would store a `free` tier and nothing else —
    // and every standard-tier module the campus had been using for months would
    // vanish as a side effect of an unrelated AI edit.
    expect(stored.plan).toBe(FEATURE_PLANS.FREE);
    expect(stored.modules.map((m) => m.key)).toEqual(
      expect.arrayContaining(['finance', 'exam', 'document', 'announcement'])
    );
    expect(stored.quotas.maxStudents).toBe(400);
    expect(stored.ai.llmProfile).toBe('gpt-4o-mini');
  });

  it('never grandfathers the AI, even while folding everything else', async () => {
    unmigrated();

    await service.applyChanges({
      campusId: CAMPUS_ID, layer: OVERRIDE_LAYERS.ADMIN, actor: ACTOR,
      ai: { llmProfile: 'gpt-4o-mini' },
    });

    expect(written().modules.some((m) => m.key === 'ai')).toBe(false);
  });

  it('says on the audit row that the fold happened', async () => {
    unmigrated();

    await service.applyChanges({
      campusId: CAMPUS_ID, layer: OVERRIDE_LAYERS.ADMIN, actor: ACTOR,
      ai: { llmProfile: 'gpt-4o-mini' },
    });

    // The overrides this write created were not decided by the actor whose name
    // is on the row; the trail has to say where they came from.
    expect(auditRow().changes.foldedLegacy).toBe(true);
  });

  it('does not fold a campus that already carries an entitlement', async () => {
    await service.applyChanges({
      campusId: CAMPUS_ID, layer: OVERRIDE_LAYERS.ADMIN, actor: ACTOR,
      modules: [{ key: 'gaet', state: FEATURE_STATES.ENABLED, reason: 'upsell agreed today' }],
    });

    expect(auditRow().changes.foldedLegacy).toBeUndefined();
    expect(written().modules.map((m) => m.key)).toEqual(['gaet']);
  });
});
