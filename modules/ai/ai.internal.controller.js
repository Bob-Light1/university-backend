'use strict';

/**
 * @file ai.internal.controller.js
 * @description Controllers of the internal ERP read API consumed only by
 * ai-service (§6.2). The S2S token is the ONLY identity source: campus, user
 * and role are never read from the query or body (§4.1 rule 1). ERP data is
 * read exclusively through the existing module service facades — never a
 * model. `aggregates` stays a 501 stub until M5.
 *
 * Response shape: like every route of the project, the payloads documented in
 * Annexe B are wrapped in { success, message, data } by the response helpers
 * (data carries the contract body: { items, nextCursor } / { allowed }).
 */

const {
  sendSuccess,
  sendError,
  sendUnauthorized,
  sendValidationError,
  asyncHandler,
} = require('../../shared/utils/response-helpers');
const { isValidObjectId } = require('../../shared/utils/validation-helpers');
const { verifyServiceToken } = require('./ai.s2s');
const aiService = require('./ai.service');

// Lazy facade: document is loaded very early by server.js and lazily requires
// this module back for the ingestion signal — both sides stay lazy (no cycle).
const documentService = () => require('../document').service;

/** §6.3.1: page size clamp applied server-side — never trust the client. */
const MAX_INGEST_LIMIT = 200;

/** Batch bound of the citation re-authorization endpoint (§6.2). */
const MAX_CITATIONS = 100;

/**
 * S2S authentication middleware — the ONLY identity source for /internal/ai.
 * The verified token context lands on req.s2s ({ userId, campusId, role, scope });
 * nothing is ever read from the body or query to derive scope (§4.1 rule 1).
 */
const authenticateService = (req, res, next) => {
  // Inert deployment: the internal API does not exist without AI config.
  if (!aiService.isEnabled()) {
    return sendError(res, 503, 'AI features are disabled on this deployment');
  }
  const header = req.header('Authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return sendUnauthorized(res, 'Missing service token');
  }
  try {
    req.s2s = verifyServiceToken(token);
  } catch {
    return sendUnauthorized(res, 'Invalid service token');
  }
  return next();
};

/**
 * Opaque keyset cursor over the stable (updatedAt, _id) ordering of the
 * ingestion feed. Encoding is a protocol detail of this API — consumers must
 * treat the string as opaque (§6.3.1).
 */
const encodeCursor = ({ updatedAt, id }) =>
  Buffer.from(JSON.stringify({ u: new Date(updatedAt).toISOString(), i: id })).toString('base64url');

/** @returns {{afterUpdatedAt: Date, afterId: string}|null} null = malformed cursor. */
const decodeCursor = (raw) => {
  try {
    const { u, i } = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    const afterUpdatedAt = new Date(u);
    if (Number.isNaN(afterUpdatedAt.getTime()) || !isValidObjectId(String(i))) return null;
    return { afterUpdatedAt, afterId: String(i) };
  } catch {
    return null;
  }
};

/**
 * GET /internal/ai/ingestables — paginated ingestion feed (contract §6.3.1).
 * Campus scope comes from the verified S2S token exclusively; a token without
 * campusId (global-role platform context) cannot ingest — ingestion is always
 * per campus. `sourceId` serves the event-driven single-document path.
 */
const listIngestables = asyncHandler(async (req, res) => {
  const campusId = req.s2s.campusId;
  if (!campusId) {
    return sendError(res, 400, 'Ingestion requires a campus scope in the S2S token');
  }

  const type = String(req.query.type || 'document');
  if (type !== 'document') {
    return sendError(res, 422, `Unsupported ingestable type '${type}' (v1 indexes documents only, D6)`);
  }

  const requested = parseInt(req.query.limit, 10);
  const limit = Math.min(Math.max(Number.isNaN(requested) ? MAX_INGEST_LIMIT : requested, 1), MAX_INGEST_LIMIT);

  let updatedAfter;
  if (req.query.updatedAfter) {
    updatedAfter = new Date(String(req.query.updatedAfter));
    if (Number.isNaN(updatedAfter.getTime())) {
      return sendValidationError(res, [{ field: 'updatedAfter', message: 'updatedAfter must be an ISO date' }]);
    }
  }

  let cursorPosition = {};
  if (req.query.cursor) {
    const decoded = decodeCursor(req.query.cursor);
    if (!decoded) {
      return sendValidationError(res, [{ field: 'cursor', message: 'malformed cursor' }]);
    }
    cursorPosition = decoded;
  }

  let sourceId = null;
  if (req.query.sourceId) {
    sourceId = String(req.query.sourceId);
    if (!isValidObjectId(sourceId)) {
      return sendValidationError(res, [{ field: 'sourceId', message: 'sourceId must be an ObjectId' }]);
    }
  }

  const { items, nextCursor } = await documentService().listAiIngestables({
    campusId,
    updatedAfter,
    ...cursorPosition,
    limit,
    sourceId,
  });

  return sendSuccess(res, 200, 'OK', {
    items,
    nextCursor: nextCursor ? encodeCursor(nextCursor) : null,
  });
});

/**
 * POST /internal/ai/authorize-citations — batch re-authorization at answer
 * time (§6.2, §4.5). The user whose rights are checked is the S2S subject —
 * an id supplied in the body could let one user read another's scope.
 */
const authorizeCitations = asyncHandler(async (req, res) => {
  const citations = req.body?.citations;
  if (!Array.isArray(citations) || citations.length === 0) {
    return sendValidationError(res, [{ field: 'citations', message: 'citations must be a non-empty array' }]);
  }
  if (citations.length > MAX_CITATIONS) {
    return sendValidationError(res, [{ field: 'citations', message: `at most ${MAX_CITATIONS} citations per batch` }]);
  }

  // v1: only document sources are indexable (D6) — anything else is denied by
  // omission (the response only ever contains the authorized subset).
  const documentIds = citations
    .filter((c) => c && c.sourceType === 'document' && isValidObjectId(String(c.sourceId || '')))
    .map((c) => String(c.sourceId));

  const allowed = documentIds.length
    ? await documentService().authorizeAiCitations(
      { userId: req.s2s.userId, role: req.s2s.role, campusId: req.s2s.campusId },
      documentIds,
    )
    : [];

  return sendSuccess(res, 200, 'OK', { allowed });
});

/** GET /internal/ai/aggregates/:name — deterministic ERP aggregates (§6.5), lands in M5. */
const getAggregate = asyncHandler(async (req, res) => {
  return sendError(res, 501, "'aggregates' is not implemented yet (planned for M5)");
});

module.exports = {
  authenticateService,
  listIngestables,
  authorizeCitations,
  getAggregate,
};
