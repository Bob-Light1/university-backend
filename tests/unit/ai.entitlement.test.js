'use strict';

/**
 * Unit tests for the per-campus AI entitlement gate (§11.3) — the Node stage
 * of the defense in depth. Campus facade and ai.service are mocked (no DB, no
 * network): we test the 503/403/403/429 ladder and the request context set on
 * success — including that the scope comes from the JWT, never from the body.
 */

process.env.AI_SERVICE_SECRET = 'test-s2s-secret';
process.env.AI_SERVICE_URL = 'http://127.0.0.1:8000';

jest.mock('../../modules/ai/ai.service', () => ({
  isEnabled: jest.fn(() => true),
  fetchMonthlyUsage: jest.fn(async () => null),
}));

jest.mock('../../modules/campus', () => ({
  service: { getCampusAiEntitlement: jest.fn() },
}));

const aiService = require('../../modules/ai/ai.service');
const campusFacade = require('../../modules/campus');
const { requireAiFeature } = require('../../modules/ai/ai.entitlement.middleware');

const CAMPUS_ID = '0'.repeat(24);
const OTHER_CAMPUS_ID = '1'.repeat(24);

const entitledCampus = (overrides = {}) => ({
  campus_name: 'Test Campus',
  status: 'active',
  aiEntitlement: {
    enabled: true,
    plan: 'standard',
    llmProfile: 'free',
    monthlyTokenBudget: 1000,
    features: { chat: true, search: true, analytics: true, advisors: false },
    ...overrides,
  },
});

const mockReq = (overrides = {}) => ({
  user: { id: 'u1', role: 'STUDENT', campusId: CAMPUS_ID },
  query: {},
  body: {},
  ...overrides,
});

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

/** Runs the asyncHandler-wrapped middleware and waits for its promise chain. */
const run = async (mw, req, res) => {
  const next = jest.fn();
  mw(req, res, next);
  await new Promise(setImmediate);
  return next;
};

// Jest workers share process.env across test files — do not leak AI config
// into files that assert the inert behaviour (smoke tests).
afterAll(() => {
  delete process.env.AI_SERVICE_URL;
  delete process.env.AI_SERVICE_SECRET;
});

beforeEach(() => {
  jest.clearAllMocks();
  aiService.isEnabled.mockReturnValue(true);
  aiService.fetchMonthlyUsage.mockResolvedValue(null);
});

describe('requireAiFeature — kill-switch & subscription ladder', () => {
  test('503 AI_DISABLED when the gateway is not configured', async () => {
    aiService.isEnabled.mockReturnValue(false);
    const res = mockRes();
    await run(requireAiFeature('chat'), mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, errors: { code: 'AI_DISABLED' } })
    );
  });

  test('403 AI_NOT_ENABLED when the campus has not subscribed', async () => {
    campusFacade.service.getCampusAiEntitlement.mockResolvedValue(
      entitledCampus({ enabled: false })
    );
    const res = mockRes();
    await run(requireAiFeature('chat'), mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ errors: { code: 'AI_NOT_ENABLED' } })
    );
  });

  test('403 AI_FEATURE_NOT_IN_PLAN when the feature is outside the plan', async () => {
    campusFacade.service.getCampusAiEntitlement.mockResolvedValue(entitledCampus());
    const res = mockRes();
    await run(requireAiFeature('advisors'), mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ errors: { code: 'AI_FEATURE_NOT_IN_PLAN' } })
    );
  });

  test('429 AI_BUDGET_EXCEEDED when the monthly token budget is spent', async () => {
    campusFacade.service.getCampusAiEntitlement.mockResolvedValue(entitledCampus());
    aiService.fetchMonthlyUsage.mockResolvedValue({ period: '2026-07', tokensIn: 900, tokensOut: 200 });
    const res = mockRes();
    await run(requireAiFeature('chat'), mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ errors: { code: 'AI_BUDGET_EXCEEDED' } })
    );
  });

  test('passes and attaches the entitlement when everything is in order', async () => {
    campusFacade.service.getCampusAiEntitlement.mockResolvedValue(entitledCampus());
    const req = mockReq();
    const next = await run(requireAiFeature('chat'), req, mockRes());
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.aiCampusId).toBe(CAMPUS_ID);
    expect(req.aiEntitlement.plan).toBe('standard');
  });

  test('fails open on budget when usage counters are unavailable (ai-service re-checks)', async () => {
    campusFacade.service.getCampusAiEntitlement.mockResolvedValue(entitledCampus());
    aiService.fetchMonthlyUsage.mockResolvedValue(null);
    const next = await run(requireAiFeature('chat'), mockReq(), mockRes());
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('requireAiFeature — scope comes from the JWT, never the body', () => {
  test('a scoped role cannot redirect the check to another campus via body/query', async () => {
    campusFacade.service.getCampusAiEntitlement.mockResolvedValue(entitledCampus());
    const req = mockReq({
      user: { id: 'u1', role: 'STUDENT', campusId: CAMPUS_ID },
      body: { campusId: OTHER_CAMPUS_ID },
      query: { campusId: OTHER_CAMPUS_ID },
    });
    await run(requireAiFeature('chat'), req, mockRes());
    expect(campusFacade.service.getCampusAiEntitlement).toHaveBeenCalledWith(CAMPUS_ID);
    expect(req.aiCampusId).toBe(CAMPUS_ID);
  });

  test('403 when a scoped role has no campusId in its JWT (isolation breach prevented)', async () => {
    const res = mockRes();
    await run(requireAiFeature('chat'), mockReq({ user: { id: 'u1', role: 'STUDENT' } }), res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('global role without campus target gets the platform context (free profile, all features)', async () => {
    const req = mockReq({ user: { id: 'a1', role: 'ADMIN' } });
    const next = await run(requireAiFeature('advisors'), req, mockRes());
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.aiCampusId).toBe('');
    expect(req.aiEntitlement.llmProfile).toBe('free');
    expect(campusFacade.service.getCampusAiEntitlement).not.toHaveBeenCalled();
  });

  test('global role targeting ?campusId= is subject to that campus entitlement', async () => {
    campusFacade.service.getCampusAiEntitlement.mockResolvedValue(
      entitledCampus({ enabled: false })
    );
    const res = mockRes();
    const req = mockReq({ user: { id: 'a1', role: 'ADMIN' }, query: { campusId: OTHER_CAMPUS_ID } });
    await run(requireAiFeature('chat'), req, res);
    expect(campusFacade.service.getCampusAiEntitlement).toHaveBeenCalledWith(OTHER_CAMPUS_ID);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('400 when a global role sends a malformed ?campusId= (no silent platform fallback)', async () => {
    const res = mockRes();
    const req = mockReq({ user: { id: 'a1', role: 'ADMIN' }, query: { campusId: 'not-an-objectid' } });
    const next = await run(requireAiFeature('chat'), req, res);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(campusFacade.service.getCampusAiEntitlement).not.toHaveBeenCalled();
    expect(req.aiEntitlement).toBeUndefined();
  });
});
