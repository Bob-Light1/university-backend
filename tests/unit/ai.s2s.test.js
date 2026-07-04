'use strict';

/**
 * Unit tests for the S2S JWT layer of the ai module (§4.2).
 * Verifies the frozen contract with ai-service (HS256, iss/aud both ways,
 * TTL ≤ 300 s, campusId required for scoped roles) — the Python side enforces
 * the exact same rules (ai-service/app/core/security.py).
 */

process.env.AI_SERVICE_SECRET = 'test-s2s-secret';
process.env.AI_SERVICE_URL = 'http://127.0.0.1:8000';

const jwt = require('jsonwebtoken');
const { signServiceToken, verifyServiceToken, S2S_TTL_SECONDS } = require('../../modules/ai/ai.s2s');

const SECRET = 'test-s2s-secret';

// Jest workers share process.env across test files — do not leak AI config
// into files that assert the inert behaviour (smoke tests).
afterAll(() => {
  delete process.env.AI_SERVICE_URL;
  delete process.env.AI_SERVICE_SECRET;
});

/** Mints an incoming (ai-service → Node) token with overridable claims. */
const mintServiceToken = (overrides = {}, { ttl = 300, issuer = 'ai-service', audience = 'erp-backend' } = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { sub: 'svc-user', campusId: '0'.repeat(24), role: 'STUDENT', scope: [], iat: now, exp: now + ttl, ...overrides },
    SECRET,
    { algorithm: 'HS256', issuer, audience }
  );
};

describe('signServiceToken (Node → ai-service)', () => {
  test('carries the frozen claim set: iss/aud/sub/campusId/role/plan/llmProfile, TTL 300 s', () => {
    const token = signServiceToken({
      userId: 'u1',
      campusId: 'c1',
      role: 'STUDENT',
      plan: 'premium',
      llmProfile: 'premium',
    });
    const claims = jwt.verify(token, SECRET, {
      algorithms: ['HS256'],
      issuer: 'erp-backend',
      audience: 'ai-service',
    });
    expect(claims.sub).toBe('u1');
    expect(claims.campusId).toBe('c1');
    expect(claims.role).toBe('STUDENT');
    expect(claims.plan).toBe('premium');
    expect(claims.llmProfile).toBe('premium');
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(S2S_TTL_SECONDS);
  });

  test('defaults plan/llmProfile to free and empty campusId for global roles', () => {
    const token = signServiceToken({ userId: 'admin1', campusId: null, role: 'ADMIN' });
    const claims = jwt.decode(token);
    expect(claims.campusId).toBe('');
    expect(claims.plan).toBe('free');
    expect(claims.llmProfile).toBe('free');
  });

  test('carries the M4 claims: language and a non-negative monthlyTokenBudget', () => {
    const token = signServiceToken({
      userId: 'u1',
      campusId: 'c1',
      role: 'STUDENT',
      language: 'fr',
      monthlyTokenBudget: 200000,
    });
    const claims = jwt.decode(token);
    expect(claims.language).toBe('fr');
    expect(claims.monthlyTokenBudget).toBe(200000);

    // Defaults: 'en' / 0 (unlimited); a negative budget is clamped to 0.
    const defaults = jwt.decode(signServiceToken({ userId: 'u1', campusId: 'c1', role: 'STUDENT' }));
    expect(defaults.language).toBe('en');
    expect(defaults.monthlyTokenBudget).toBe(0);
    const clamped = jwt.decode(
      signServiceToken({ userId: 'u1', campusId: 'c1', role: 'STUDENT', monthlyTokenBudget: -5 })
    );
    expect(clamped.monthlyTokenBudget).toBe(0);
  });
});

describe('verifyServiceToken (ai-service → Node)', () => {
  test('accepts a valid service token and returns the context', () => {
    const ctx = verifyServiceToken(mintServiceToken());
    expect(ctx).toMatchObject({ userId: 'svc-user', role: 'STUDENT', campusId: '0'.repeat(24) });
  });

  test('rejects a token with the wrong issuer (a Node-issued token cannot come back in)', () => {
    const token = mintServiceToken({}, { issuer: 'erp-backend', audience: 'erp-backend' });
    expect(() => verifyServiceToken(token)).toThrow();
  });

  test('rejects a token with the wrong audience', () => {
    const token = mintServiceToken({}, { audience: 'ai-service' });
    expect(() => verifyServiceToken(token)).toThrow();
  });

  test('rejects a TTL above the 300 s contract', () => {
    const token = mintServiceToken({}, { ttl: 3600 });
    expect(() => verifyServiceToken(token)).toThrow(/TTL/);
  });

  test('rejects a scoped role without campusId (§4.1 rule 1)', () => {
    const token = mintServiceToken({ campusId: '' });
    expect(() => verifyServiceToken(token)).toThrow(/campusId/);
  });

  test('accepts a global role without campusId', () => {
    const ctx = verifyServiceToken(mintServiceToken({ campusId: '', role: 'ADMIN' }));
    expect(ctx.role).toBe('ADMIN');
    expect(ctx.campusId).toBe('');
  });

  test('rejects a token signed with another secret (forged)', () => {
    const now = Math.floor(Date.now() / 1000);
    const forged = jwt.sign(
      { sub: 'x', campusId: 'c', role: 'STUDENT', iat: now, exp: now + 60 },
      'other-secret',
      { algorithm: 'HS256', issuer: 'ai-service', audience: 'erp-backend' }
    );
    expect(() => verifyServiceToken(forged)).toThrow();
  });
});
