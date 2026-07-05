'use strict';

/**
 * Unit tests for the internal ERP read API of the ai module (M3, §6.2/§6.3.1)
 * and for the security invariants of §4.6 on the Node side:
 *  - scope falsification: campus/user always come from the S2S token, never
 *    from the query or the body;
 *  - ingestion contract: limit clamped ≤ 200, opaque cursor round-trip;
 *  - citation re-authorization delegates the token identity to the document
 *    facade and only returns the authorized subset;
 *  - aggregates (M5, §8): role gate, campus from the token, per-report param
 *    validation, PII-free figures passed through verbatim.
 * The document/result/student facades are mocked (no DB, no network).
 */

process.env.AI_SERVICE_SECRET = 'test-s2s-secret';
process.env.AI_SERVICE_URL = 'http://127.0.0.1:8000';

jest.mock('../../modules/document', () => ({
  service: {
    listAiIngestables: jest.fn(async () => ({ items: [], nextCursor: null })),
    authorizeAiCitations: jest.fn(async () => []),
  },
}));

jest.mock('../../modules/result', () => ({
  service: {
    getCampusOverviewAggregates: jest.fn(async () => ({ avgNormalized: 12.34, totalPublished: 40 })),
    getDropoutRiskDistribution: jest.fn(async () => ({ studentsAssessed: 25, highRisk: 3 })),
    isValidAcademicYear: jest.fn((v) => /^\d{4}-\d{4}$/.test(String(v))),
    isValidSemester: jest.fn((v) => ['S1', 'S2', 'Annual'].includes(v)),
  },
}));

jest.mock('../../modules/student', () => ({
  service: {
    summarizeAttendanceTotals: jest.fn(async () => [{ total: 200, present: 180 }]),
    getAvgAbsenceRateForCampus: jest.fn(async () => [{ avgAbsenceRate: 9.96 }]),
  },
}));

jest.mock('../../modules/finance', () => ({
  service: {
    getOverdueAgingAggregates: jest.fn(async () => ({
      totalCount: 3, totalOutstanding: 200, buckets: [],
    })),
    getMonthlyCashflowSeries: jest.fn(async () => ({ months: 6, series: [] })),
  },
}));

jest.mock('../../modules/partner', () => ({
  service: {
    getLeadFunnelAggregates: jest.fn(async () => ({
      totalLeads: 60, enrolledLeads: 6, conversionRate: 10,
    })),
  },
}));

const documentFacade = require('../../modules/document');
const resultFacade = require('../../modules/result');
const studentFacade = require('../../modules/student');
const financeFacade = require('../../modules/finance');
const partnerFacade = require('../../modules/partner');
const { signServiceToken } = require('../../modules/ai/ai.s2s');
const {
  authenticateService,
  listIngestables,
  authorizeCitations,
  getAggregate,
} = require('../../modules/ai/ai.internal.controller');

const CAMPUS_A = 'a'.repeat(24);
const CAMPUS_B = 'b'.repeat(24);
const USER_ID = 'c'.repeat(24);
const DOC_ID = 'd'.repeat(24);

// The internal API verifies tokens signed by ai-service (iss ai-service →
// aud erp-backend). signServiceToken signs the opposite direction, so tests
// build the incoming token manually with the same shared secret.
const jwt = require('jsonwebtoken');
const incomingToken = (claims = {}) =>
  jwt.sign(
    { sub: USER_ID, campusId: CAMPUS_A, role: 'SERVICE', scope: [], ...claims },
    process.env.AI_SERVICE_SECRET,
    { algorithm: 'HS256', issuer: 'ai-service', audience: 'erp-backend', expiresIn: 120 },
  );

const mockReq = ({ token = incomingToken(), query = {}, body = {}, params = {} } = {}) => ({
  header: (name) => (name === 'Authorization' ? `Bearer ${token}` : undefined),
  query,
  body,
  params,
});

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

/** Authenticates then runs an asyncHandler-wrapped controller. */
const run = async (controller, req, res) => {
  const next = jest.fn();
  authenticateService(req, res, next);
  if (next.mock.calls.length === 0) return; // auth already answered
  controller(req, res, jest.fn());
  await new Promise(setImmediate);
};

const sentPayload = (res) => res.json.mock.calls[0][0];

beforeEach(() => jest.clearAllMocks());

describe('authenticateService', () => {
  test('rejects a Node-signed token (wrong issuer/audience direction)', async () => {
    const wrongDirection = signServiceToken({ userId: USER_ID, campusId: CAMPUS_A, role: 'SERVICE' });
    const req = mockReq({ token: wrongDirection });
    const res = mockRes();
    await run(listIngestables, req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('rejects a token signed with another secret', async () => {
    const forged = jwt.sign(
      { sub: USER_ID, campusId: CAMPUS_A, role: 'SERVICE' },
      'not-the-secret',
      { algorithm: 'HS256', issuer: 'ai-service', audience: 'erp-backend', expiresIn: 120 },
    );
    const res = mockRes();
    await run(listIngestables, mockReq({ token: forged }), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('GET /internal/ai/ingestables', () => {
  test('campus scope comes from the token — a campusId in the query is ignored (§4.6 falsification)', async () => {
    const req = mockReq({ query: { campusId: CAMPUS_B, limit: '10' } });
    const res = mockRes();
    await run(listIngestables, req, res);
    expect(documentFacade.service.listAiIngestables).toHaveBeenCalledWith(
      expect.objectContaining({ campusId: CAMPUS_A }),
    );
  });

  test('clamps the limit to 200 (§6.3.1) and floors it at 1', async () => {
    const res1 = mockRes();
    await run(listIngestables, mockReq({ query: { limit: '9999' } }), res1);
    expect(documentFacade.service.listAiIngestables).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 200 }),
    );

    const res2 = mockRes();
    await run(listIngestables, mockReq({ query: { limit: '-5' } }), res2);
    expect(documentFacade.service.listAiIngestables).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 1 }),
    );
  });

  test('refuses a token without campus scope (ingestion is always per campus)', async () => {
    const req = mockReq({ token: incomingToken({ role: 'ADMIN', campusId: '' }) });
    const res = mockRes();
    await run(listIngestables, req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(documentFacade.service.listAiIngestables).not.toHaveBeenCalled();
  });

  test('cursor round-trip: the returned nextCursor decodes back to the same keyset position', async () => {
    const updatedAt = new Date('2026-07-03T10:00:00.000Z');
    documentFacade.service.listAiIngestables.mockResolvedValueOnce({
      items: [{ sourceId: DOC_ID }],
      nextCursor: { updatedAt, id: DOC_ID },
    });

    const res1 = mockRes();
    await run(listIngestables, mockReq(), res1);
    const { nextCursor } = sentPayload(res1).data;
    expect(typeof nextCursor).toBe('string');

    const res2 = mockRes();
    await run(listIngestables, mockReq({ query: { cursor: nextCursor } }), res2);
    expect(documentFacade.service.listAiIngestables).toHaveBeenLastCalledWith(
      expect.objectContaining({ afterUpdatedAt: updatedAt, afterId: DOC_ID }),
    );
  });

  test('rejects a malformed cursor with 400', async () => {
    const res = mockRes();
    await run(listIngestables, mockReq({ query: { cursor: '!!not-a-cursor!!' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects a non-document type (D6: v1 indexes documents only)', async () => {
    const res = mockRes();
    await run(listIngestables, mockReq({ query: { type: 'result' } }), res);
    expect(res.status).toHaveBeenCalledWith(422);
  });
});

describe('POST /internal/ai/authorize-citations', () => {
  test('identity forwarded to the facade is the token identity — body userId/campusId ignored (§4.6)', async () => {
    const req = mockReq({
      body: {
        userId: 'evil-user',
        campusId: CAMPUS_B,
        citations: [{ sourceType: 'document', sourceId: DOC_ID }],
      },
    });
    const res = mockRes();
    await run(authorizeCitations, req, res);
    expect(documentFacade.service.authorizeAiCitations).toHaveBeenCalledWith(
      { userId: USER_ID, role: 'SERVICE', campusId: CAMPUS_A },
      [DOC_ID],
    );
  });

  test('non-document and malformed source ids are dropped before the facade call', async () => {
    const req = mockReq({
      body: {
        citations: [
          { sourceType: 'result', sourceId: DOC_ID },
          { sourceType: 'document', sourceId: 'not-an-objectid' },
          { sourceType: 'document', sourceId: DOC_ID },
        ],
      },
    });
    const res = mockRes();
    await run(authorizeCitations, req, res);
    expect(documentFacade.service.authorizeAiCitations).toHaveBeenCalledWith(
      expect.anything(),
      [DOC_ID],
    );
  });

  test('answers only the authorized subset returned by the facade', async () => {
    documentFacade.service.authorizeAiCitations.mockResolvedValueOnce([
      { sourceType: 'document', sourceId: DOC_ID, label: 'Doc', url: `/documents/${DOC_ID}` },
    ]);
    const res = mockRes();
    await run(authorizeCitations, mockReq({
      body: { citations: [{ sourceType: 'document', sourceId: DOC_ID }] },
    }), res);
    expect(sentPayload(res).data.allowed).toHaveLength(1);
  });

  test('rejects an oversized batch (bound of §6.2)', async () => {
    const citations = Array.from({ length: 101 }, () => ({ sourceType: 'document', sourceId: DOC_ID }));
    const res = mockRes();
    await run(authorizeCitations, mockReq({ body: { citations } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(documentFacade.service.authorizeAiCitations).not.toHaveBeenCalled();
  });
});

describe('GET /internal/ai/aggregates/:name (M5, §8)', () => {
  // The S2S subject of an analytics call is the END USER (Node re-applies the
  // role gate of the public route) — a staffing role by default here.
  const managerToken = (claims = {}) => incomingToken({ role: 'CAMPUS_MANAGER', ...claims });

  test('unknown aggregate → 404, nothing computed', async () => {
    const res = mockRes();
    await run(getAggregate, mockReq({ token: managerToken(), params: { name: 'nope' } }), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(resultFacade.service.getCampusOverviewAggregates).not.toHaveBeenCalled();
  });

  test('non-staffing role (STUDENT) → 403 (defense in depth of the route gate)', async () => {
    const res = mockRes();
    await run(getAggregate, mockReq({
      token: incomingToken({ role: 'STUDENT' }),
      params: { name: 'class-performance' },
    }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(resultFacade.service.getCampusOverviewAggregates).not.toHaveBeenCalled();
  });

  test('token without campus scope → 400 (aggregates are always per campus)', async () => {
    const res = mockRes();
    await run(getAggregate, mockReq({
      token: incomingToken({ role: 'ADMIN', campusId: '' }),
      params: { name: 'class-performance' },
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('campus comes from the token; a campusId query param is rejected as unknown (§4.6 falsification)', async () => {
    const res = mockRes();
    await run(getAggregate, mockReq({
      token: managerToken(),
      params: { name: 'class-performance' },
      query: { campusId: CAMPUS_B },
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(resultFacade.service.getCampusOverviewAggregates).not.toHaveBeenCalled();
  });

  test('validated params forwarded with the token campus (class-performance)', async () => {
    const res = mockRes();
    await run(getAggregate, mockReq({
      token: managerToken(),
      params: { name: 'class-performance' },
      query: { academicYear: '2025-2026', semester: 'S1' },
    }), res);
    expect(resultFacade.service.getCampusOverviewAggregates).toHaveBeenCalledWith({
      campusId: CAMPUS_A, academicYear: '2025-2026', semester: 'S1',
    });
    const { data } = sentPayload(res);
    expect(data.name).toBe('class-performance');
    expect(data.figures).toEqual({ avgNormalized: 12.34, totalPublished: 40 });
    expect(typeof data.computedAt).toBe('string');
  });

  test('invalid param format → 400 before any facade call', async () => {
    const res = mockRes();
    await run(getAggregate, mockReq({
      token: managerToken(),
      params: { name: 'dropout-risk' },
      query: { academicYear: 'not-a-year' },
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(resultFacade.service.getDropoutRiskDistribution).not.toHaveBeenCalled();
  });

  test('attendance-summary: derived PII-free figures from the student facades', async () => {
    const res = mockRes();
    await run(getAggregate, mockReq({
      token: managerToken(),
      params: { name: 'attendance-summary' },
    }), res);
    expect(studentFacade.service.summarizeAttendanceTotals).toHaveBeenCalledTimes(1);
    expect(studentFacade.service.getAvgAbsenceRateForCampus).toHaveBeenCalledTimes(1);
    const { data } = sentPayload(res);
    expect(data.figures).toEqual({
      totalSessions: 200,
      presentCount: 180,
      absentCount: 20,
      attendanceRate: 90,
      avgAbsenceRatePerStudent: 10,
    });
  });

  test('attendance-summary on an empty campus: explicit zeros/nulls, never NaN', async () => {
    studentFacade.service.summarizeAttendanceTotals.mockResolvedValueOnce([]);
    studentFacade.service.getAvgAbsenceRateForCampus.mockResolvedValueOnce([]);
    const res = mockRes();
    await run(getAggregate, mockReq({
      token: managerToken(),
      params: { name: 'attendance-summary' },
    }), res);
    const { data } = sentPayload(res);
    expect(data.figures).toEqual({
      totalSessions: 0,
      presentCount: 0,
      absentCount: 0,
      attendanceRate: null,
      avgAbsenceRatePerStudent: null,
    });
  });
});

describe('GET /internal/ai/aggregates/:name — advisor aggregates (M5b, §6.5/D9)', () => {
  const managerToken = (claims = {}) => incomingToken({ role: 'CAMPUS_MANAGER', ...claims });

  test('staffing-but-not-direction role (TEACHER) → 403 on an advisor aggregate, 200 on an analytics one', async () => {
    // Stricter per-aggregate gate: TEACHER passes ANALYTICS_ROLES…
    const okRes = mockRes();
    await run(getAggregate, mockReq({
      token: incomingToken({ role: 'TEACHER' }),
      params: { name: 'attendance-summary' },
    }), okRes);
    expect(okRes.json.mock.calls[0][0].success).toBe(true);

    // …but never ADVISOR_ROLES (D9: direction only).
    const koRes = mockRes();
    await run(getAggregate, mockReq({
      token: incomingToken({ role: 'TEACHER' }),
      params: { name: 'finance-overdue-aging' },
    }), koRes);
    expect(koRes.status).toHaveBeenCalledWith(403);
    expect(financeFacade.service.getOverdueAgingAggregates).not.toHaveBeenCalled();
  });

  test('finance-overdue-aging: campus from the token, figures verbatim', async () => {
    const res = mockRes();
    await run(getAggregate, mockReq({
      token: managerToken(),
      params: { name: 'finance-overdue-aging' },
    }), res);
    expect(financeFacade.service.getOverdueAgingAggregates).toHaveBeenCalledWith({
      campusId: CAMPUS_A,
    });
    const { data } = sentPayload(res);
    expect(data.figures).toEqual({ totalCount: 3, totalOutstanding: 200, buckets: [] });
  });

  test('finance-cashflow-monthly: months whitelist — valid forwarded, invalid → 400', async () => {
    const okRes = mockRes();
    await run(getAggregate, mockReq({
      token: managerToken(),
      params: { name: 'finance-cashflow-monthly' },
      query: { months: '6' },
    }), okRes);
    expect(financeFacade.service.getMonthlyCashflowSeries).toHaveBeenCalledWith({
      campusId: CAMPUS_A, months: '6',
    });

    for (const bad of ['2', '25', 'abc']) {
      const koRes = mockRes();
      await run(getAggregate, mockReq({
        token: managerToken(),
        params: { name: 'finance-cashflow-monthly' },
        query: { months: bad },
      }), koRes);
      expect(koRes.status).toHaveBeenCalledWith(400);
    }
    expect(financeFacade.service.getMonthlyCashflowSeries).toHaveBeenCalledTimes(1);
  });

  test('lead-funnel: no params accepted — any key (even a scope) → 400', async () => {
    const res = mockRes();
    await run(getAggregate, mockReq({
      token: managerToken(),
      params: { name: 'lead-funnel' },
      query: { campusId: CAMPUS_B },
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(partnerFacade.service.getLeadFunnelAggregates).not.toHaveBeenCalled();

    const okRes = mockRes();
    await run(getAggregate, mockReq({ token: managerToken(), params: { name: 'lead-funnel' } }), okRes);
    expect(partnerFacade.service.getLeadFunnelAggregates).toHaveBeenCalledWith({
      campusId: CAMPUS_A,
    });
  });
});
