'use strict';

/**
 * Integration smokes for the per-campus entitlement gate
 * (`shared/middleware/entitlement.js`, design doc §7.1) via Supertest.
 *
 * NO database: what is verified here is the GATE, not any module's behaviour.
 * Every assertion below is a decision that happens before a controller runs,
 * which is exactly the property that makes the gate worth having — the design
 * doc is explicit that a frontend-only implementation is worse than none
 * (§12: "un flag front-only est *pire* que rien").
 *
 * The gate is mounted as path-scoped middleware ahead of every router, so a URL
 * no router handles still passes through it. That is what lets these tests
 * distinguish "the gate refused" (403 + a dedicated code) from "the gate let it
 * through" (404, the router had nothing for it) without touching Mongo.
 */

delete process.env.AI_SERVICE_URL;
delete process.env.AI_SERVICE_SECRET;

const jwt = require('jsonwebtoken');
const request = require('supertest');

const {
  FEATURE_STATES,
  FEATURE_PLANS,
  FEATURE_ERROR_CODES,
} = require('../../shared/constants/features.constants');
const { resolveEntitlement } = require('../../shared/utils/entitlement');

// Only the campus lookup is stubbed; the resolver, the gate and every mount
// stay real.
jest.mock('../../shared/lib/entitlement/entitlement.service', () => {
  const actual = jest.requireActual('../../shared/lib/entitlement/entitlement.service');
  return { ...actual, resolveForCampus: jest.fn() };
});

const entitlementService = require('../../shared/lib/entitlement/entitlement.service');
const app = require('../../app');

const SECRET = process.env.JWT_SECRET;
const USER_ID = '507f1f77bcf86cd799439011';
const CAMPUS_ID = '507f1f77bcf86cd799439012';

const tokenFor = (role, extra = {}) =>
  jwt.sign({ id: USER_ID, role, ...extra }, SECRET, { issuer: 'school-management-app' });

const auth = (req, role, extra = { campusId: CAMPUS_ID }) =>
  req.set('Authorization', `Bearer ${tokenFor(role, extra)}`);

/** Makes the campus resolve to a given plan plus optional overrides. */
const campusOn = (plan, modules = []) =>
  entitlementService.resolveForCampus.mockResolvedValue(
    resolveEntitlement({ plan, modules })
  );

beforeEach(() => {
  entitlementService.resolveForCampus.mockReset();
  campusOn(FEATURE_PLANS.PREMIUM);
});

describe('the gate — hidden module', () => {
  beforeEach(() => campusOn(FEATURE_PLANS.FREE));   // finance is standard+

  test('refuses a read with 403 FEATURE_DISABLED', async () => {
    const res = await auth(request(app).get('/api/finance/summary'), 'TEACHER');
    expect(res.status).toBe(403);
    expect(res.body.errors.code).toBe(FEATURE_ERROR_CODES.FEATURE_DISABLED);
    expect(res.body.errors.feature).toBe('finance');
  });

  test('refuses a write with the same code', async () => {
    const res = await auth(request(app).post('/api/finance/expenses'), 'TEACHER');
    expect(res.status).toBe(403);
    expect(res.body.errors.code).toBe(FEATURE_ERROR_CODES.FEATURE_DISABLED);
  });

  test('carries a code distinct from a role refusal — the frontend must tell them apart (§8.3)', async () => {
    const res = await auth(request(app).get('/api/gaet/constraints'), 'TEACHER');
    expect(res.body.errors.code).toBe(FEATURE_ERROR_CODES.FEATURE_DISABLED);
    expect(res.body.errors.code).not.toBe('FORBIDDEN');
  });
});

describe('the gate — frozen module (read_only)', () => {
  beforeEach(() => campusOn(
    FEATURE_PLANS.PREMIUM,
    [{ key: 'announcement', state: FEATURE_STATES.READ_ONLY, until: null, setBy: 'admin' }]
  ));

  test('lets a read through — the history stays consultable', async () => {
    const path = '/api/announcements/507f1f77bcf86cd799439013';
    const [read, write] = await Promise.all([
      auth(request(app).get(path), 'TEACHER'),
      auth(request(app).put(path), 'TEACHER'),
    ]);

    // Asserted on the CODE, not on the status: a read may still be refused
    // further down for a role reason, and that is a different layer's job. What
    // must never happen is the entitlement gate refusing it — freezing a module
    // amputating its history is precisely what `read_only` exists to avoid.
    expect(read.body?.errors?.code).not.toBe(FEATURE_ERROR_CODES.FEATURE_READ_ONLY);
    expect(write.body?.errors?.code).toBe(FEATURE_ERROR_CODES.FEATURE_READ_ONLY);
  });

  test('refuses a write with 403 FEATURE_READ_ONLY', async () => {
    const res = await auth(request(app).post('/api/announcements'), 'TEACHER');
    expect(res.status).toBe(403);
    expect(res.body.errors.code).toBe(FEATURE_ERROR_CODES.FEATURE_READ_ONLY);
  });

  test.each(['put', 'patch', 'delete'])('refuses %s too — every mutation, not just POST', async (method) => {
    const res = await auth(request(app)[method]('/api/announcements/507f1f77bcf86cd799439013'), 'TEACHER');
    expect(res.status).toBe(403);
    expect(res.body.errors.code).toBe(FEATURE_ERROR_CODES.FEATURE_READ_ONLY);
  });
});

describe('the gate — who it does not apply to', () => {
  test('never binds a global role: an ADMIN reaches a module the campus disabled (§5.2)', async () => {
    campusOn(FEATURE_PLANS.FREE);
    const res = await auth(request(app).get('/api/finance/summary'), 'ADMIN', {});
    expect(res.body?.errors?.code).not.toBe(FEATURE_ERROR_CODES.FEATURE_DISABLED);
    expect(entitlementService.resolveForCampus).not.toHaveBeenCalled();
  });

  test('leaves authentication to authenticate(): no token answers 401, not 403', async () => {
    campusOn(FEATURE_PLANS.FREE);
    const res = await request(app).get('/api/finance/summary');
    expect(res.status).toBe(401);
  });

  test('never gates a core module, whatever the tier', async () => {
    campusOn(FEATURE_PLANS.FREE);
    const res = await auth(request(app).get('/api/settings/entitlement'), 'TEACHER');
    expect(res.status).toBe(200);
    expect(res.body.data.features.settings).toBe(FEATURE_STATES.ENABLED);
  });
});

describe('the gate — fail-open (§4.3)', () => {
  test('lets the request through when the entitlement cannot be read at all', async () => {
    entitlementService.resolveForCampus.mockRejectedValue(new Error('mongo down'));
    const res = await auth(request(app).get('/api/finance/summary'), 'TEACHER');
    // A lookup failure must degrade into "the platform works", never into
    // "every module of every tenant just vanished". This is the deliberate
    // inversion of buildCampusFilter() / notDeletedFilter().
    expect(res.body?.errors?.code).not.toBe(FEATURE_ERROR_CODES.FEATURE_DISABLED);
  });

  test('lets the request through when the JWT carries no campus', async () => {
    campusOn(FEATURE_PLANS.FREE);
    const res = await auth(request(app).get('/api/finance/summary'), 'TEACHER', {});
    expect(res.body?.errors?.code).not.toBe(FEATURE_ERROR_CODES.FEATURE_DISABLED);
  });
});

describe('GET /api/settings/entitlement — hydration (§8.1)', () => {
  test('returns the effective states of the caller\'s own campus', async () => {
    campusOn(FEATURE_PLANS.STANDARD);
    const res = await auth(request(app).get('/api/settings/entitlement'), 'TEACHER');

    expect(res.status).toBe(200);
    expect(res.body.data.campusId).toBe(CAMPUS_ID);
    expect(res.body.data.plan).toBe(FEATURE_PLANS.STANDARD);
    expect(res.body.data.features.finance).toBe(FEATURE_STATES.ENABLED);
    expect(res.body.data.features.gaet).toBe(FEATURE_STATES.HIDDEN);
    expect(res.body.data.unrestricted).toBe(false);
  });

  test('carries the registry metadata the UI renders, and no access rule (§8.2)', async () => {
    const res = await auth(request(app).get('/api/settings/entitlement'), 'TEACHER');
    expect(res.body.data.registry.finance).toEqual({
      label: 'Finance', core: false, minPlan: FEATURE_PLANS.STANDARD,
    });
  });

  test('answers a global role with the whole estate and no plan badge', async () => {
    const res = await auth(request(app).get('/api/settings/entitlement'), 'DIRECTOR', {});
    expect(res.body.data.unrestricted).toBe(true);
    expect(res.body.data.plan).toBeNull();
    expect(res.body.data.features.gaet).toBe(FEATURE_STATES.ENABLED);
  });

  test('rejects a malformed ?campusId= rather than silently answering platform-wide', async () => {
    const res = await auth(request(app).get('/api/settings/entitlement?campusId=nope'), 'ADMIN', {});
    expect(res.status).toBe(400);
  });

  test('ignores ?campusId= for a scoped role — the campus comes from the JWT (CLAUDE.md §2)', async () => {
    const other = '507f1f77bcf86cd799439099';
    const res = await auth(request(app).get(`/api/settings/entitlement?campusId=${other}`), 'TEACHER');
    expect(res.body.data.campusId).toBe(CAMPUS_ID);
    expect(entitlementService.resolveForCampus).toHaveBeenCalledWith(CAMPUS_ID);
  });
});
