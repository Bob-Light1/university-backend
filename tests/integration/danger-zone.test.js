'use strict';

/**
 * Integration smokes for the danger zone (`/api/danger-zone`) via Supertest.
 *
 * NO database: these tests verify the *gate*, not the deletion. Every assertion here is a
 * rejection that must happen BEFORE any DB access — which is exactly the property that makes
 * the gate worth having. If one of these starts returning 200, an unauthenticated or
 * unauthorized caller has reached a permanent-deletion code path.
 */

delete process.env.AI_SERVICE_URL;
delete process.env.AI_SERVICE_SECRET;

const jwt = require('jsonwebtoken');
const request = require('supertest');
const app = require('../../app');

const SECRET = process.env.JWT_SECRET;
const ENTITY_ID = '507f1f77bcf86cd799439011';
const CAMPUS_ID = '507f1f77bcf86cd799439012';

const tokenFor = (role, extra = {}) =>
  jwt.sign({ id: ENTITY_ID, role, ...extra }, SECRET, { issuer: 'school-management-app' });

const auth = (req, role, extra) => req.set('Authorization', `Bearer ${tokenFor(role, extra)}`);

describe('danger zone — authentication', () => {
  test.each([
    ['get',    '/api/danger-zone/entities'],
    ['get',    '/api/danger-zone/history'],
    ['get',    `/api/danger-zone/student/${ENTITY_ID}/impact`],
    ['delete', `/api/danger-zone/student/${ENTITY_ID}`],
  ])('%s %s without a token → 401', async (method, route) => {
    const res = await request(app)[method](route);
    expect(res.status).toBe(401);
  });
});

describe('danger zone — coarse role gate', () => {
  test.each(['TEACHER', 'STUDENT', 'PARENT', 'MENTOR', 'STAFF'])(
    'a %s cannot reach the danger zone at all → 403',
    async (role) => {
      const res = await auth(request(app).get('/api/danger-zone/entities'), role, { campusId: CAMPUS_ID });
      expect(res.status).toBe(403);
    },
  );

  test('an ADMIN gets the catalogue and the confirmation policy', async () => {
    const res = await auth(request(app).get('/api/danger-zone/entities'), 'ADMIN');

    expect(res.status).toBe(200);
    expect(res.body.data.entities.map((e) => e.key)).toContain('student');
    expect(res.body.data.policy).toMatchObject({
      confirmationVerb: 'DELETE',
      requiresPassword: true,
    });
    expect(res.body.data.policy.minReasonLength).toBeGreaterThan(0);
  });
});

describe('danger zone — per-entity role gate (registry)', () => {
  test('a CAMPUS_MANAGER sees only the entity it owns', async () => {
    const res = await auth(request(app).get('/api/danger-zone/entities'), 'CAMPUS_MANAGER', { campusId: CAMPUS_ID });

    expect(res.status).toBe(200);
    expect(res.body.data.entities.map((e) => e.key)).toEqual(['staff-role']);
  });

  test('a CAMPUS_MANAGER is refused on an entity it does not own → 403', async () => {
    const res = await auth(
      request(app).get(`/api/danger-zone/student/${ENTITY_ID}/impact`),
      'CAMPUS_MANAGER',
      { campusId: CAMPUS_ID },
    );

    expect(res.status).toBe(403);
  });

  test('a DIRECTOR is refused on an ADMIN-only entity → 403', async () => {
    const res = await auth(request(app).get(`/api/danger-zone/student/${ENTITY_ID}/impact`), 'DIRECTOR');
    expect(res.status).toBe(403);
  });
});

describe('danger zone — input validation happens before any DB access', () => {
  test('an unregistered entity type → 400', async () => {
    const res = await auth(request(app).get(`/api/danger-zone/unicorn/${ENTITY_ID}/impact`), 'ADMIN');

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not a permanently deletable entity/i);
  });

  test('a prototype-pollution probe is not treated as a registry entry → 400', async () => {
    const res = await auth(request(app).get(`/api/danger-zone/__proto__/${ENTITY_ID}/impact`), 'ADMIN');
    expect(res.status).toBe(400);
  });

  test('a malformed ObjectId → 400', async () => {
    const res = await auth(request(app).get('/api/danger-zone/student/not-an-id/impact'), 'ADMIN');

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid/i);
  });

  test('a deletion with an empty body is refused on the justification → 400', async () => {
    const res = await auth(request(app).delete(`/api/danger-zone/student/${ENTITY_ID}`), 'ADMIN').send({});

    // The reason is the first control checked, and it fails without touching the DB.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/justification/i);
  });

  test.each([
    ['confirmation phrase', { reason: 'a valid justification', password: 'x', ticket: 'x' }, /confirmation phrase/i],
    ['password',            { reason: 'a valid justification', confirmationPhrase: 'DELETE X', ticket: 'x' }, /password/i],
    ['ticket',              { reason: 'a valid justification', confirmationPhrase: 'DELETE X', password: 'x' }, /ticket/i],
  ])('a deletion missing the %s → 400, still without a DB round-trip', async (_label, body, matcher) => {
    const res = await auth(request(app).delete(`/api/danger-zone/student/${ENTITY_ID}`), 'ADMIN').send(body);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(matcher);
  });
});

describe('danger zone — deletion attempts are rate-limited', () => {
  /**
   * The limiter is the last line of defence behind the password control. It also has its own
   * store prefix: sharing `strictLimiter` would let GAET generations or admin creations
   * exhaust the danger-zone budget, and vice versa.
   */
  test('repeated attempts from the same IP eventually hit 429', async () => {
    const attempt = () =>
      auth(request(app).delete(`/api/danger-zone/student/${ENTITY_ID}`), 'ADMIN').send({});

    let sawRateLimit = false;
    for (let i = 0; i < 15 && !sawRateLimit; i += 1) {
      const res = await attempt();
      if (res.status === 429) sawRateLimit = true;
    }

    expect(sawRateLimit).toBe(true);
  });
});
