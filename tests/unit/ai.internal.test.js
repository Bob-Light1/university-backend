'use strict';

/**
 * Unit tests for the internal ERP read API of the ai module (M3, §6.2/§6.3.1)
 * and for the security invariants of §4.6 on the Node side:
 *  - scope falsification: campus/user always come from the S2S token, never
 *    from the query or the body;
 *  - ingestion contract: limit clamped ≤ 200, opaque cursor round-trip;
 *  - citation re-authorization delegates the token identity to the document
 *    facade and only returns the authorized subset.
 * The document facade is mocked (no DB, no network).
 */

process.env.AI_SERVICE_SECRET = 'test-s2s-secret';
process.env.AI_SERVICE_URL = 'http://127.0.0.1:8000';

jest.mock('../../modules/document', () => ({
  service: {
    listAiIngestables: jest.fn(async () => ({ items: [], nextCursor: null })),
    authorizeAiCitations: jest.fn(async () => []),
  },
}));

const documentFacade = require('../../modules/document');
const { signServiceToken } = require('../../modules/ai/ai.s2s');
const {
  authenticateService,
  listIngestables,
  authorizeCitations,
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

const mockReq = ({ token = incomingToken(), query = {}, body = {} } = {}) => ({
  header: (name) => (name === 'Authorization' ? `Bearer ${token}` : undefined),
  query,
  body,
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
