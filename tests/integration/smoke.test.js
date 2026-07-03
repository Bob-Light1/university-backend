'use strict';

/**
 * Integration smoke tests via Supertest against the imported Express app (app.js).
 * NO database: we verify the routing wiring + auth middlewares,
 * not the business logic. Protected routes must reject (401) BEFORE
 * touching the DB; /api/health reports 'disconnected' for lack of a connection.
 */

// The ai module must be INERT here: other test files (ai.s2s, ai.entitlement)
// set AI_* env vars and jest workers share the process env across files.
delete process.env.AI_SERVICE_URL;
delete process.env.AI_SERVICE_SECRET;

const jwt = require('jsonwebtoken');
const request = require('supertest');
const app = require('../../app');

describe('Routes publiques de service', () => {
  test('GET /api/ping → 200', async () => {
    const res = await request(app).get('/api/ping');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('GET /api/health → 503 (pas de DB dans le harnais de test)', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body.database).toBe('disconnected');
  });
});

describe('Garde d authentification (rejet avant accès DB)', () => {
  test.each([
    '/api/students',
    '/api/teachers',
    '/api/results',
    '/api/documents',
  ])('GET %s sans token → 401', async (route) => {
    const res = await request(app).get(route);
    expect(res.status).toBe(401);
  });
});

describe('Module ai — passerelle inerte sans AI_SERVICE_URL (PHASE3_AI_DESIGN.md §11.1)', () => {
  const userToken = () =>
    jwt.sign(
      { id: '0'.repeat(24), role: 'STUDENT', campusId: '1'.repeat(24) },
      process.env.JWT_SECRET,
      { issuer: 'school-management-app', expiresIn: '5m' }
    );

  test.each([
    ['post', '/api/ai/chat'],
    ['post', '/api/ai/search'],
    ['get', '/api/ai/conversations'],
    ['get', '/api/ai/usage'],
  ])('%s %s sans token → 401', async (method, route) => {
    const res = await request(app)[method](route);
    expect(res.status).toBe(401);
  });

  test('POST /api/ai/chat authentifié mais IA non configurée → 503 AI_DISABLED (aucun appel externe)', async () => {
    const res = await request(app)
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ message: 'hello' });
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.errors).toEqual({ code: 'AI_DISABLED' });
  });

  test('GET /internal/ai/ingestables → 503 quand l IA est désactivée (API interne inerte)', async () => {
    const res = await request(app).get('/internal/ai/ingestables');
    expect(res.status).toBe(503);
  });
});

describe('Routing', () => {
  test('route inconnue → 404 JSON', async () => {
    const res = await request(app).get('/api/cette-route-nexiste-pas');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
