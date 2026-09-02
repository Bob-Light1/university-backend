'use strict';

/**
 * Phase 5 — "the edges" (`docs/architecture/CAMPUS_ENTITLEMENT_DESIGN.md` §9).
 *
 * The gate on the HTTP surface is pinned by `tests/integration/entitlement.test.js`.
 * What this suite pins is everything that happens WITHOUT a request: the eight
 * crons, the notification foundation, the public portal and the quotas. Those
 * are the sites where a mistake is silent — a cron has no user watching it, and
 * "no email was sent" is the one failure nobody reports.
 *
 * Four things are pinned here, in order of what they protect:
 *
 *  1. the emission/hygiene split cannot drift out of the registry — a job that
 *     starts emitting, or one that gets renamed, fails the suite instead of
 *     quietly keeping its budget;
 *  2. the gate itself fails OPEN, everywhere, on every failure mode (§4.3);
 *  3. every notification template has a declared owner;
 *  4. the quota chain reads what the campus was sold, not what the schema
 *     defaults to.
 */

const {
  FEATURE_STATES,
  FEATURE_KEYS,
  FEATURE_PLANS,
  FEATURE_CRONS,
  CRON_NATURE,
  DEFAULT_QUOTAS,
} = require('../../shared/constants/features.constants');
const { projectJobs } = require('../../shared/lib/register-jobs');
const { resolveQuota, OVERRIDE_LAYERS } = require('../../shared/utils/entitlement');

// `mock`-prefixed so jest allows the factory below to close over it.
const mockCampusFacade = {
  getCampusEntitlement:   jest.fn(),
  listCampusEntitlements: jest.fn(),
};
jest.mock('../../modules/campus', () => ({ service: mockCampusFacade }));

const jobs = require('../../shared/lib/entitlement/entitlement.jobs');
const cache = require('../../shared/lib/entitlement/entitlement.cache');
const { TEMPLATE_FEATURES, featureOfTemplate } = require('../../modules/notification/notification.features');

const CAMPUS_ID = '507f1f77bcf86cd799439012';

/** An entitlement putting exactly `key` into `state`, everything else on. */
const withModule = (key, state) => ({
  plan: FEATURE_PLANS.PREMIUM,
  modules: [{ key, state, until: null, reason: '', setBy: OVERRIDE_LAYERS.ADMIN, setAt: new Date() }],
});

beforeEach(() => {
  jest.clearAllMocks();
  cache.clear();
  mockCampusFacade.getCampusEntitlement.mockResolvedValue({ _id: CAMPUS_ID, entitlement: null });
  mockCampusFacade.listCampusEntitlements.mockResolvedValue([]);
});

// ─── 1. The emission/hygiene split, against the registry ──────────────────────

describe('emission sites (§9.1)', () => {
  it('covers every cron the registry marks EMISSION', () => {
    // The direction that matters: a new emitting job added to the registry
    // without being wired here would keep mailing a campus that switched its
    // module off — the exact incident this phase exists to prevent.
    for (const name of jobs.declaredEmissionJobs()) {
      expect(jobs.emissionFeatureOf(name)).toBeTruthy();
    }
  });

  it('names only real jobs, owned by the feature it claims', () => {
    const scheduled = projectJobs().map((job) => job.name);
    for (const [name, feature] of Object.entries(jobs.EMISSION_SITES)) {
      // A renamed job must not leave a gate pointing at nothing.
      expect(scheduled).toContain(name);
      expect(FEATURE_KEYS).toContain(feature);
      expect(jobs.featureOwningJob(name)).toBe(feature);
    }
  });

  it('gates competition-closing even though the job itself is hygiene', () => {
    // The case that proves the map cannot be derived from `nature` alone: the
    // closing must always settle the ranking, and only the winner mails stop.
    const entry = FEATURE_CRONS.find((cron) => cron.name === 'competition-closing');
    expect(entry.nature).toBe(CRON_NATURE.HYGIENE);
    expect(jobs.emissionFeatureOf('competition-closing')).toBe('public-portal');
  });

  it('leaves the hygiene-only jobs ungated', () => {
    // Retention answers a legal duty and the print sweep drains in-flight jobs:
    // silencing either is a worse outcome than an over-visible module.
    for (const name of ['document-retention', 'print-queue-sweep', 'announcement-expiry', 'notification-retry']) {
      expect(jobs.emissionFeatureOf(name)).toBeNull();
    }
  });
});

// ─── 2. The gate — and its fail-open behaviour (§4.3) ─────────────────────────

describe('isEmissionAllowed', () => {
  it('lets an enabled module emit', async () => {
    mockCampusFacade.getCampusEntitlement.mockResolvedValue({
      _id: CAMPUS_ID, entitlement: withModule('finance', FEATURE_STATES.ENABLED),
    });
    await expect(jobs.isEmissionAllowed(CAMPUS_ID, 'finance')).resolves.toBe(true);
  });

  it('silences a hidden module', async () => {
    mockCampusFacade.getCampusEntitlement.mockResolvedValue({
      _id: CAMPUS_ID, entitlement: withModule('finance', FEATURE_STATES.HIDDEN),
    });
    await expect(jobs.isEmissionAllowed(CAMPUS_ID, 'finance')).resolves.toBe(false);
  });

  it('silences a FROZEN module too — emission is an action, not a read', async () => {
    // `read_only` keeps the ledger readable and stops the module acting. Mailing
    // a dunning notice from a ledger the operator has just frozen would
    // contradict, by email, what their screen says.
    mockCampusFacade.getCampusEntitlement.mockResolvedValue({
      _id: CAMPUS_ID, entitlement: withModule('finance', FEATURE_STATES.READ_ONLY),
    });
    await expect(jobs.isEmissionAllowed(CAMPUS_ID, 'finance')).resolves.toBe(false);
  });

  it('emits when the campus is unknown, unset or unreadable', async () => {
    await expect(jobs.isEmissionAllowed(null, 'finance')).resolves.toBe(true);
    await expect(jobs.isEmissionAllowed(CAMPUS_ID, 'finance')).resolves.toBe(true); // no entitlement
    cache.clear();
    mockCampusFacade.getCampusEntitlement.mockRejectedValue(new Error('mongo down'));
    await expect(jobs.isEmissionAllowed(CAMPUS_ID, 'finance')).resolves.toBe(true);
  });
});

describe('suppressedCampusIds', () => {
  it('returns only the campuses that may not emit', async () => {
    mockCampusFacade.listCampusEntitlements.mockResolvedValue([
      { _id: 'a', entitlement: withModule('finance', FEATURE_STATES.HIDDEN) },
      { _id: 'b', entitlement: withModule('finance', FEATURE_STATES.READ_ONLY) },
      { _id: 'c', entitlement: withModule('finance', FEATURE_STATES.ENABLED) },
      { _id: 'd', entitlement: withModule('exam', FEATURE_STATES.HIDDEN) },
    ]);
    await expect(jobs.suppressedCampusIds('finance')).resolves.toEqual(['a', 'b']);
  });

  it('never suppresses a campus that carries no entitlement', async () => {
    // Those campuses are not even scanned — the query only returns configured
    // ones — so the socle stays inert until the migration has run (§4.3).
    await expect(jobs.suppressedCampusIds('finance')).resolves.toEqual([]);
  });

  it('suppresses NOTHING when the estate cannot be read', async () => {
    // A job skipping every campus because one lookup failed is an outage that
    // takes days to attribute to entitlement.
    mockCampusFacade.listCampusEntitlements.mockRejectedValue(new Error('mongo down'));
    await expect(jobs.suppressedCampusIds('finance')).resolves.toEqual([]);
  });

  it('never suppresses a core module, and does not even ask', async () => {
    // `core` is ENABLED for everyone by construction (§5.1). Answering without
    // a lookup matters where it is read most: the activation and welcome mails
    // go out one per created account.
    mockCampusFacade.listCampusEntitlements.mockResolvedValue([
      { _id: 'a', entitlement: withModule('notification', FEATURE_STATES.HIDDEN) },
    ]);
    await expect(jobs.suppressedCampusIds('notification')).resolves.toEqual([]);
    expect(mockCampusFacade.listCampusEntitlements).not.toHaveBeenCalled();

    await expect(jobs.isEmissionAllowed(CAMPUS_ID, 'account')).resolves.toBe(true);
    expect(mockCampusFacade.getCampusEntitlement).not.toHaveBeenCalled();
  });
});

// ─── 3. Notification attribution (§9.4) ───────────────────────────────────────

describe('notification templates', () => {
  const catalog = require('../../shared/i18n/catalogs/notifications');

  it('declares an owner for every template the platform can render', () => {
    // A template shipped without an owner is an emission nothing governs.
    for (const key of ['generic', ...Object.keys(catalog)]) {
      expect(Object.prototype.hasOwnProperty.call(TEMPLATE_FEATURES, key)).toBe(true);
    }
  });

  it('declares no template the catalog does not have', () => {
    for (const key of Object.keys(TEMPLATE_FEATURES)) {
      if (key === 'generic') continue;
      expect(Object.keys(catalog)).toContain(key);
    }
  });

  it('names only real registry keys', () => {
    for (const feature of Object.values(TEMPLATE_FEATURES)) {
      if (feature === null) continue;
      expect(FEATURE_KEYS).toContain(feature);
    }
  });

  it('leaves an unattributable template ungoverned rather than guessing', () => {
    // `generic` carries caller-authored content: nothing in it says which module
    // it came from, and guessing would silence a campus-wide announcement.
    expect(featureOfTemplate('generic')).toBeNull();
    expect(featureOfTemplate('some.future.template')).toBeNull();
  });
});

// ─── 4. Quotas (§9.3) ─────────────────────────────────────────────────────────

describe('resolveQuota', () => {
  it('prefers what the campus was sold', () => {
    const campus = { entitlement: { quotas: { maxStudents: 4000 } }, features: { maxStudents: 1500 } };
    expect(resolveQuota(campus, 'maxStudents')).toBe(4000);
  });

  it('falls back to the legacy object for an unmigrated campus', () => {
    // Until `scripts/migrate-entitlement.js` runs, this is the ONLY source
    // carrying a negotiated ceiling. Skipping it would reset the whole estate
    // to the default the day this shipped.
    expect(resolveQuota({ features: { maxStudents: 1500 } }, 'maxStudents')).toBe(1500);
  });

  it('falls back to the platform default, then to a deployment knob', () => {
    expect(resolveQuota(null, 'maxStudents')).toBe(DEFAULT_QUOTAS.maxStudents);
    expect(resolveQuota({}, 'maxDocumentStorageMB', { fallback: 200 })).toBe(200);
    // The knob sits at the END of the chain: it never overrules a sold quota.
    expect(resolveQuota({ entitlement: { quotas: { maxDocumentStorageMB: 900 } } },
      'maxDocumentStorageMB', { fallback: 200 })).toBe(900);
  });

  it('ignores a stored value that is not a usable ceiling', () => {
    // 0 means "nobody can create anything" in a comparison, never "unlimited".
    expect(resolveQuota({ entitlement: { quotas: { maxClasses: 0 } }, features: { maxClasses: 80 } }, 'maxClasses')).toBe(80);
    expect(resolveQuota({ features: { maxClasses: -1 } }, 'maxClasses')).toBe(DEFAULT_QUOTAS.maxClasses);
  });

  it('throws on an undeclared quota rather than resolving to undefined', () => {
    // `n < undefined` is false, so a typo would refuse every creation with no
    // message saying why.
    expect(() => resolveQuota({}, 'maxWhatever')).toThrow(/unknown quota/);
  });
});

// ─── 5. The public portal surface (§9.2) ──────────────────────────────────────

describe('public portal write routes', () => {
  const fs = require('fs');
  const path = require('path');
  const { PORTAL_WRITE_ROUTES } = require('../../modules/public-portal/portal-campus');

  it('declares exactly the non-GET routes mounted on /api/public', () => {
    // A submission endpoint added without `{ write: true }` would keep taking
    // leads for a campus that closed its intake, and nothing would say so.
    const source = fs.readFileSync(
      path.join(__dirname, '../../modules/public-portal/public.routes.js'), 'utf8'
    );
    const mounted = [...source.matchAll(/router\.(post|put|patch|delete)\('([^']+)'/g)]
      .map((match) => match[2])
      .sort();
    expect(mounted).toEqual([...PORTAL_WRITE_ROUTES].sort());
  });
});
