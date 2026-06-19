'use strict';

/**
 * Integration smoke tests via Supertest against the imported Express app (app.js).
 * NO database: we verify the routing wiring + auth middlewares,
 * not the business logic. Protected routes must reject (401) BEFORE
 * touching the DB; /api/health reports 'disconnected' for lack of a connection.
 */

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

describe('Routing', () => {
  test('route inconnue → 404 JSON', async () => {
    const res = await request(app).get('/api/cette-route-nexiste-pas');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
