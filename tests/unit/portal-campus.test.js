'use strict';

/**
 * @file portal-campus.test.js
 * @description The public portal under per-campus entitlement —
 * `docs/architecture/CAMPUS_ENTITLEMENT_DESIGN.md` §9.2.
 *
 * `/api/public/*` is the one gated surface with no JWT: the app-level gate sees
 * no identity there and lets everything through by design. The check therefore
 * happens where the campus becomes known, and the two things worth pinning are
 * the two that are silent when wrong:
 *
 *  - a hidden portal answers EXACTLY like an absent campus. A 403 saying "this
 *    campus has not subscribed" would publish a tenant's commercial standing to
 *    anyone holding a URL;
 *  - a frozen portal keeps serving its pages and refuses only the submissions.
 *    Answering 404 there would take a live site down instead of closing an
 *    intake.
 */

const { FEATURE_STATES, FEATURE_ERROR_CODES, FEATURE_PLANS } = require('../../shared/constants/features.constants');
const { OVERRIDE_LAYERS } = require('../../shared/utils/entitlement');

const mockCampusFacade = {
  getActiveCampusBySlug:  jest.fn(),
  getActiveCampusById:    jest.fn(),
  getCampusEntitlement:   jest.fn(),
};
jest.mock('../../modules/campus', () => ({ service: mockCampusFacade }));

const cache = require('../../shared/lib/entitlement/entitlement.cache');
const {
  resolvePortalCampus, filterPortalCampuses, portalState,
} = require('../../modules/public-portal/portal-campus');

const CAMPUS = { _id: '507f1f77bcf86cd799439012', campusSlug: 'douala', campus_name: 'Douala' };

/** Fake Express response capturing the answer. */
const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json   = (payload) => { res.body = payload; return res; };
  return res;
};

/** Puts the portal of the stored campus into `state`. */
const portalIn = (state) => {
  mockCampusFacade.getCampusEntitlement.mockResolvedValue({
    _id: CAMPUS._id,
    entitlement: state === null ? null : {
      plan: FEATURE_PLANS.PREMIUM,
      modules: [{
        key: 'public-portal', state, until: null, reason: '',
        setBy: OVERRIDE_LAYERS.ADMIN, setAt: new Date(),
      }],
    },
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  cache.clear();
  mockCampusFacade.getActiveCampusBySlug.mockResolvedValue(CAMPUS);
  mockCampusFacade.getActiveCampusById.mockResolvedValue(CAMPUS);
  portalIn(FEATURE_STATES.ENABLED);
});

describe('resolvePortalCampus — enabled', () => {
  it('returns the campus for a read and for a write', async () => {
    const res = makeRes();
    await expect(resolvePortalCampus(res, { slug: 'douala' })).resolves.toEqual(CAMPUS);
    await expect(resolvePortalCampus(res, { slug: 'douala', write: true })).resolves.toEqual(CAMPUS);
    expect(res.statusCode).toBeNull();
  });

  it('resolves by id too — the ?ref=PARTNER_CODE path', async () => {
    const res = makeRes();
    await expect(resolvePortalCampus(res, { id: CAMPUS._id })).resolves.toEqual(CAMPUS);
    expect(mockCampusFacade.getActiveCampusById).toHaveBeenCalledWith(CAMPUS._id, '_id');
  });
});

describe('resolvePortalCampus — hidden', () => {
  it('answers 404, indistinguishable from a campus that does not exist', async () => {
    portalIn(FEATURE_STATES.HIDDEN);
    const hidden = makeRes();
    const absent = makeRes();

    await expect(resolvePortalCampus(hidden, { slug: 'douala' })).resolves.toBeNull();

    mockCampusFacade.getActiveCampusBySlug.mockResolvedValue(null);
    await expect(resolvePortalCampus(absent, { slug: 'nope' })).resolves.toBeNull();

    // Byte for byte the same answer — the whole point (§4.1.2).
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).toEqual(absent.body);
  });

  it('closes the referral path as well as the slug path', async () => {
    // A partner link must not reach a campus its own slug could not.
    portalIn(FEATURE_STATES.HIDDEN);
    const res = makeRes();
    await expect(resolvePortalCampus(res, { id: CAMPUS._id })).resolves.toBeNull();
    expect(res.statusCode).toBe(404);
  });
});

describe('resolvePortalCampus — read_only', () => {
  it('keeps serving the pages', async () => {
    portalIn(FEATURE_STATES.READ_ONLY);
    const res = makeRes();
    await expect(resolvePortalCampus(res, { slug: 'douala' })).resolves.toEqual(CAMPUS);
    expect(res.statusCode).toBeNull();
  });

  it('refuses a submission with the code the frontend already handles', async () => {
    portalIn(FEATURE_STATES.READ_ONLY);
    const res = makeRes();

    await expect(resolvePortalCampus(res, { slug: 'douala', write: true })).resolves.toBeNull();

    expect(res.statusCode).toBe(403);
    // 403 and not 404: the site is up, only the intake is closed. And the same
    // error code the authenticated surface uses, so one handler covers both.
    expect(res.body.errors?.code ?? res.body.code ?? res.body.error?.code)
      .toBe(FEATURE_ERROR_CODES.FEATURE_READ_ONLY);
  });
});

describe('resolvePortalCampus — fail-open (§4.3)', () => {
  it('serves the campus when the entitlement cannot be read', async () => {
    mockCampusFacade.getCampusEntitlement.mockRejectedValue(new Error('mongo down'));
    const res = makeRes();
    await expect(resolvePortalCampus(res, { slug: 'douala', write: true })).resolves.toEqual(CAMPUS);
  });

  it('serves an unmigrated campus — the socle stays inert until the migration runs', async () => {
    portalIn(null);
    await expect(portalState(CAMPUS._id)).resolves.toBe(FEATURE_STATES.ENABLED);
  });
});

describe('filterPortalCampuses', () => {
  it('drops the hidden ones and keeps the frozen ones', async () => {
    // The selection page is the one place a campus appears without being asked
    // for by name: listing a hidden one would advertise a page that then 404s.
    // A frozen campus stays — its site is up, only the intake is closed.
    const byId = {
      a: FEATURE_STATES.HIDDEN,
      b: FEATURE_STATES.READ_ONLY,
      c: FEATURE_STATES.ENABLED,
    };
    mockCampusFacade.getCampusEntitlement.mockImplementation(async (id) => ({
      _id: id,
      entitlement: {
        plan: FEATURE_PLANS.PREMIUM,
        modules: [{
          key: 'public-portal', state: byId[id], until: null, reason: '',
          setBy: OVERRIDE_LAYERS.ADMIN, setAt: new Date(),
        }],
      },
    }));

    const kept = await filterPortalCampuses([{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }]);

    expect(kept.map((campus) => campus._id)).toEqual(['b', 'c']);
  });
});
