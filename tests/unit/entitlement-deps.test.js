'use strict';

/**
 * The refusal side of the entitlement system — the probes
 * (`shared/lib/entitlement/entitlement.usage.js`) and the guard
 * (`shared/lib/entitlement/entitlement.guard.js`), design doc §4.1.1 / §6.3.3.
 *
 * Like `tests/unit/hard-delete.test.js`, the first half runs against the REAL
 * schemas rather than a mock, because the failure mode here is silent in both
 * directions and neither shows up in production as an error:
 *
 *   - a probe pointing at a path that does not exist counts ZERO rows, so the
 *     blocker never blocks and a module in daily use is hidden on request;
 *   - a probe on a model with no campus field counts the WHOLE platform, so
 *     one tenant's data refuses another tenant's toggle.
 *
 * Two of the seven `subject` edges are nested paths (`courseRequirements.subjectId`,
 * `subject.subjectId`). Written at the document root — the obvious spelling —
 * they match nothing at all. That is what this file exists to catch.
 *
 * The second half drives the guard with the probes mocked, so the decision
 * logic is pinned independently of the data.
 */

const {
  FEATURE_STATES,
  FEATURE_PLANS,
  FEATURE_KEYS,
  FEATURE_REGISTRY,
  FEATURE_REQUIRED_BY,
  CORE_FEATURE_KEYS,
  FLOORED_FEATURE_KEYS,
  FEATURE_ERROR_CODES,
  MAX_UNTIL_MONTHS,
} = require('../../shared/constants/features.constants');

const usage = require('../../shared/lib/entitlement/entitlement.usage');
const { resolveEntitlement, OVERRIDE_LAYERS } = require('../../shared/utils/entitlement');

const NOW = new Date('2026-08-15T12:00:00.000Z');

// ─── Part 1 — the probes, against the real schemas ───────────────────────────

describe('entitlement.usage — declarations pinned against the real models', () => {
  it('declares an edge list for every registry key — "no dependants" is stated, never forgotten', () => {
    expect(Object.keys(usage.HARD_EDGES).sort()).toEqual([...FEATURE_KEYS].sort());
  });

  it('resolves every declared model', () => {
    for (const edges of Object.values(usage.HARD_EDGES)) {
      for (const { model } of edges) {
        expect(() => usage.resolveModel(model)).not.toThrow();
      }
    }
  });

  it('points every edge at a path that EXISTS on the model', () => {
    const missing = [];
    for (const [key, edges] of Object.entries(usage.HARD_EDGES)) {
      for (const { model, path } of edges) {
        if (!usage.resolveModel(model).schema.path(path)) missing.push(`${key}: ${model}.${path}`);
      }
    }
    // A filter on a non-existent path matches nothing: a blocker that never blocks.
    expect(missing).toEqual([]);
  });

  it('points every edge at a REQUIRED reference — a soft link never justifies a refusal', () => {
    const soft = [];
    for (const [key, edges] of Object.entries(usage.HARD_EDGES)) {
      for (const { model, path } of edges) {
        const schemaPath = usage.resolveModel(model).schema.path(path);
        if (!schemaPath?.options?.required) soft.push(`${key}: ${model}.${path}`);
      }
    }
    expect(soft).toEqual([]);
  });

  it('probes only campus-scoped models — a global collection cannot refuse a per-campus toggle', () => {
    const global = [];
    for (const [key, edges] of Object.entries(usage.HARD_EDGES)) {
      for (const { model } of edges) {
        if (!usage.resolveCampusPath(usage.resolveModel(model))) global.push(`${key}: ${model}`);
      }
    }
    // `Course.level` is the documented casualty of this rule: Course carries no
    // campus, so counting it would refuse `level` on every campus of the estate
    // because of one course created somewhere else.
    expect(global).toEqual([]);
  });

  it('declares a probe for every non-core key something structurally depends on', () => {
    const uncovered = FEATURE_KEYS.filter((key) =>
      !FEATURE_REGISTRY[key].core &&
      FEATURE_REQUIRED_BY[key].length > 0 &&
      usage.HARD_EDGES[key].length === 0);
    expect(uncovered).toEqual([]);
  });

  it('covers each dependant module of `subject` — the most coupled non-core key', () => {
    // subject is required by result · exam · gaet · student · teacher: the five
    // that will produce nearly every refusal in practice.
    const models = usage.HARD_EDGES.subject.map((e) => e.model);
    expect(models).toEqual(expect.arrayContaining([
      'Result', 'ExamSession', 'QuestionBank', 'GaetConstraint',
      'StudentSchedule', 'StudentAttendance', 'TeacherAttendance',
    ]));
  });

  it('keeps every floored module\'s `records` on a campus-scoped model', () => {
    for (const key of FLOORED_FEATURE_KEYS) {
      for (const model of FEATURE_REGISTRY[key].records) {
        expect(() => usage.resolveModel(model)).not.toThrow();
        expect(usage.resolveCampusPath(usage.resolveModel(model))).not.toBeNull();
      }
    }
  });

  it('reads the campus field from the schema instead of assuming one name', () => {
    // Three names coexist across the codebase; hard-coding the wrong one gives
    // Mongo a filter it happily ignores, i.e. a count over every tenant.
    expect(usage.resolveCampusPath(usage.resolveModel('Result'))).toBe('schoolCampus');
    expect(usage.resolveCampusPath(usage.resolveModel('Document'))).toBe('campusId');
  });
});

// ─── Part 2 — the guard, with the probes mocked ──────────────────────────────

describe('entitlement.guard', () => {
  let guard;
  let findUsageBlockers;
  let findRecordBlockers;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../../shared/lib/entitlement/entitlement.usage', () => ({
      findUsageBlockers: jest.fn().mockResolvedValue([]),
      findRecordBlockers: jest.fn().mockResolvedValue([]),
    }));
    ({ findUsageBlockers, findRecordBlockers } = require('../../shared/lib/entitlement/entitlement.usage'));
    guard = require('../../shared/lib/entitlement/entitlement.guard');
  });

  afterEach(() => jest.dontMock('../../shared/lib/entitlement/entitlement.usage'));

  const resolved = (data) => resolveEntitlement(data, { now: NOW });

  describe('authority controls (family A)', () => {
    it.each(CORE_FEATURE_KEYS)('refuses to restrict the core module %s, even for the ADMIN', (key) => {
      const { blockers } = guard.checkOverrideAuthority({
        key, state: FEATURE_STATES.HIDDEN, layer: OVERRIDE_LAYERS.ADMIN, offer: resolved(null), now: NOW,
      });
      expect(blockers).toHaveLength(1);
      expect(blockers[0].code).toBe(FEATURE_ERROR_CODES.FEATURE_CORE);
      expect(blockers[0].status).toBe(409);
    });

    it('lets the admin layer raise a module above its plan', () => {
      const { blockers } = guard.checkOverrideAuthority({
        key: 'gaet', state: FEATURE_STATES.ENABLED, layer: OVERRIDE_LAYERS.ADMIN,
        offer: resolved({ plan: FEATURE_PLANS.FREE }), now: NOW,
      });
      expect(blockers).toEqual([]);
    });

    it('refuses a campus override that would widen the offer (403)', () => {
      const { blockers } = guard.checkOverrideAuthority({
        key: 'gaet', state: FEATURE_STATES.ENABLED, layer: OVERRIDE_LAYERS.CAMPUS,
        offer: resolved({ plan: FEATURE_PLANS.FREE }), now: NOW,
      });
      expect(blockers[0].code).toBe(FEATURE_ERROR_CODES.FEATURE_NOT_IN_OFFER);
      expect(blockers[0].status).toBe(403);
      expect(blockers[0].offerState).toBe(FEATURE_STATES.HIDDEN);
    });

    it('accepts a campus override that restricts inside the offer', () => {
      const { blockers } = guard.checkOverrideAuthority({
        key: 'gaet', state: FEATURE_STATES.READ_ONLY, layer: OVERRIDE_LAYERS.CAMPUS,
        offer: resolved({ plan: FEATURE_PLANS.PREMIUM }), now: NOW,
      });
      expect(blockers).toEqual([]);
    });

    it('rejects an unknown key and an unknown state', () => {
      expect(guard.checkOverrideAuthority({
        key: 'nope', state: FEATURE_STATES.HIDDEN, layer: OVERRIDE_LAYERS.ADMIN, offer: resolved(null), now: NOW,
      }).blockers[0].status).toBe(400);

      expect(guard.checkOverrideAuthority({
        key: 'finance', state: 'turbo', layer: OVERRIDE_LAYERS.ADMIN, offer: resolved(null), now: NOW,
      }).blockers[0].status).toBe(400);
    });

    describe('the `until` time box (D-F)', () => {
      const bound = (until) => guard.validateUntil(until, NOW);

      it('accepts null and a date inside the window', () => {
        expect(bound(null).error).toBeNull();
        expect(bound(new Date('2026-12-01')).error).toBeNull();
      });

      it('refuses a malformed date, a past date, and anything past the ceiling', () => {
        expect(bound('not-a-date').error.code).toBe(FEATURE_ERROR_CODES.FEATURE_UNTIL_INVALID);
        expect(bound(new Date('2026-01-01')).error.code).toBe(FEATURE_ERROR_CODES.FEATURE_UNTIL_INVALID);

        const beyond = new Date(NOW);
        beyond.setMonth(beyond.getMonth() + MAX_UNTIL_MONTHS + 1);
        expect(bound(beyond).error.code).toBe(FEATURE_ERROR_CODES.FEATURE_UNTIL_INVALID);
      });

      it('accepts exactly the ceiling — the bound is inclusive', () => {
        const edge = new Date(NOW);
        edge.setMonth(edge.getMonth() + MAX_UNTIL_MONTHS);
        expect(bound(edge).error).toBeNull();
      });
    });
  });

  describe('impact controls (family B)', () => {
    const before = () => resolveEntitlement({ plan: FEATURE_PLANS.PREMIUM }, { now: NOW });
    const hiding = (key) => resolveEntitlement({
      plan: FEATURE_PLANS.PREMIUM,
      modules: [{ key, state: FEATURE_STATES.HIDDEN, until: null, setBy: 'admin' }],
    }, { now: NOW });

    it('passes when nothing on the campus uses the module', async () => {
      const { blockers } = await guard.checkHiddenTransitions(before(), hiding('subject'), 'campus-1');
      expect(blockers).toEqual([]);
      // A pre-opening campus may legitimately hide `subject`; without the
      // data-driven rule it would be undisableable by transitive closure (§6.3.3).
      expect(findUsageBlockers).toHaveBeenCalledWith('subject', 'campus-1');
    });

    it('refuses (409 FEATURE_IN_USE) when a collection still needs it on this campus', async () => {
      findUsageBlockers.mockResolvedValue([{ model: 'Result', label: 'Results' }]);
      const { blockers } = await guard.checkHiddenTransitions(before(), hiding('subject'), 'campus-1');
      expect(blockers[0].status).toBe(409);
      expect(blockers[0].code).toBe(FEATURE_ERROR_CODES.FEATURE_IN_USE);
      expect(blockers[0].blockedBy).toEqual(['Results']);
    });

    it('refuses (409 FEATURE_HAS_RECORDS) to hide a floored module that holds records', async () => {
      findRecordBlockers.mockResolvedValue([{ model: 'Result', label: 'Result' }]);
      const { blockers } = await guard.checkHiddenTransitions(before(), hiding('result'), 'campus-1');
      expect(blockers.map((b) => b.code)).toContain(FEATURE_ERROR_CODES.FEATURE_HAS_RECORDS);
      expect(blockers[0].message).toMatch(/read_only/);
    });

    it('never probes records on a module that carries no floor', async () => {
      await guard.checkHiddenTransitions(before(), hiding('partner'), 'campus-1');
      expect(findRecordBlockers).not.toHaveBeenCalled();
    });

    it('does not probe anything when the module is FROZEN rather than hidden', async () => {
      const frozen = resolveEntitlement({
        plan: FEATURE_PLANS.PREMIUM,
        modules: [{ key: 'result', state: FEATURE_STATES.READ_ONLY, until: null, setBy: 'admin' }],
      }, { now: NOW });

      const { blockers } = await guard.checkHiddenTransitions(before(), frozen, 'campus-1');
      expect(blockers).toEqual([]);
      expect(findUsageBlockers).not.toHaveBeenCalled();
      // Freezing keeps every row readable, so it can neither break a consumer
      // nor bury a record — that asymmetry is why `read_only` exists (§4.1).
    });

    it('ignores a module that was ALREADY hidden — only the transition is probed', async () => {
      const alreadyHidden = resolveEntitlement({ plan: FEATURE_PLANS.FREE }, { now: NOW });
      const { blockers } = await guard.checkHiddenTransitions(alreadyHidden, alreadyHidden, 'campus-1');
      expect(blockers).toEqual([]);
      expect(findUsageBlockers).not.toHaveBeenCalled();
    });

    it('catches a PLAN DOWNGRADE that hides a module no payload ever mentioned', async () => {
      findRecordBlockers.mockResolvedValue([{ model: 'FeePayment', label: 'FeePayment' }]);
      const standard = resolveEntitlement({ plan: FEATURE_PLANS.STANDARD }, { now: NOW });
      const free     = resolveEntitlement({ plan: FEATURE_PLANS.FREE }, { now: NOW });

      const { blockers } = await guard.checkHiddenTransitions(standard, free, 'campus-1');
      const financeBlock = blockers.find((b) => b.feature === 'finance');
      expect(financeBlock.code).toBe(FEATURE_ERROR_CODES.FEATURE_HAS_RECORDS);
      // Checking the submitted payload alone would let this through: the tier
      // change hides Finance through the preset, mentioning nothing.
    });

    it('reports soft edges as warnings and never as refusals', async () => {
      const { blockers, warnings } = await guard.checkHiddenTransitions(before(), hiding('finance'), 'campus-1');
      expect(blockers).toEqual([]);
      // `campus` reads finance for its dashboard tiles: it degrades, it does not break.
      expect(warnings.some((w) => w.feature === 'finance' && w.degrades === 'campus')).toBe(true);
    });
  });
});
