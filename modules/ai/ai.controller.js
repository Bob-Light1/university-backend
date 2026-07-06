'use strict';

/**
 * @file ai.controller.js
 * @description HTTP layer of the AI gateway: validates input (Annexe B
 * contracts), then delegates to ai.service which proxies to ai-service.
 * Two response modes:
 *  - JSON pass-through, re-wrapped in the project shape { success, message, data };
 *  - SSE piping for /chat (the only contract exception — raw event stream).
 * Scope (campus/user/plan) is NEVER read from the body: it travels in the S2S
 * JWT built from req.user + req.aiEntitlement (set by the entitlement gate).
 */

const { Readable } = require('node:stream');
const {
  sendSuccess,
  sendPaginated,
  sendError,
  sendValidationError,
  asyncHandler,
} = require('../../shared/utils/response-helpers');
const { AI_ERROR_CODES, AI_SEARCHABLE_SOURCE_TYPES } = require('../../shared/constants/ai.constants');
const {
  isKnownAggregate,
  isKnownAdvisor,
  validateAggregateParams,
  validateAdvisorParams,
} = require('./ai.aggregates');
const aiService = require('./ai.service');

/**
 * Preferred locale of the user, for the S2S `language` claim (M4 — the chat
 * answers in the user's language). Read through the settings facade; a
 * failure falls back to 'en' and never blocks the request.
 * @param {string} userId
 * @returns {Promise<string>}
 */
const resolvePreferredLanguage = async (userId) => {
  try {
    // Lazy require: settings is a module hub (same pattern as campus).
    return await require('../settings').service.getPreferredLanguage(userId);
  } catch {
    return 'en';
  }
};

/** Parses an upstream JSON body, tolerating empty/non-JSON responses. */
const safeJson = async (response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

/** Maps an upstream failure (network/timeout) to a clean 503 — never an opaque 500 (§6.1). */
const sendUpstreamFailure = (res, error) => {
  const timedOut = error?.name === 'AbortError' || error?.cause?.name === 'AbortError';
  return sendError(res, 503, 'AI service is temporarily unavailable', {
    code: timedOut ? AI_ERROR_CODES.UPSTREAM_TIMEOUT : AI_ERROR_CODES.INTERNAL,
  });
};

/**
 * Forwards a JSON request to ai-service and re-wraps the reply in the project
 * response shape. Upstream error statuses (401/429/501/…) pass through as-is.
 */
const proxyJson = async (req, res, path, { method = 'POST', body, language } = {}) => {
  let upstream;
  try {
    upstream = await aiService.forward(path, {
      method,
      body,
      user: req.user,
      entitlement: req.aiEntitlement,
      campusId: req.aiCampusId,
      ...(language ? { language } : {}),
    });
  } catch (error) {
    return sendUpstreamFailure(res, error);
  }
  const { response } = upstream;
  const payload = await safeJson(response);
  if (response.ok) {
    return sendSuccess(res, response.status, 'OK', payload);
  }
  return sendError(res, response.status, payload?.detail || payload?.message || 'AI service error');
};

/**
 * POST /api/ai/chat — Annexe B. Streams the upstream SSE flow without
 * buffering; on a non-stream upstream reply (e.g. 501 until M4) falls back to
 * the JSON pass-through. Client disconnect aborts the upstream call.
 */
const chat = asyncHandler(async (req, res) => {
  const { message, conversationId = null } = req.body || {};
  if (typeof message !== 'string' || message.trim().length < 1 || message.length > 4000) {
    return sendValidationError(res, [{ field: 'message', message: 'message must be a string of 1..4000 characters' }]);
  }
  if (conversationId !== null && typeof conversationId !== 'string') {
    return sendValidationError(res, [{ field: 'conversationId', message: 'conversationId must be a string or null' }]);
  }

  let upstream;
  try {
    upstream = await aiService.forward('/chat', {
      body: { message: message.trim(), conversationId },
      user: req.user,
      entitlement: req.aiEntitlement,
      campusId: req.aiCampusId,
      language: await resolvePreferredLanguage(req.user.id),
    });
  } catch (error) {
    return sendUpstreamFailure(res, error);
  }

  const { response, abort } = upstream;
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || !contentType.includes('text/event-stream')) {
    const payload = await safeJson(response);
    return sendError(res, response.ok ? 502 : response.status, payload?.detail || payload?.message || 'AI service error');
  }

  // SSE pass-through — §6.1 pitfalls: no compression (route excluded by
  // construction: we write the raw stream), no response timeout, nginx
  // buffering disabled. Keep-alive comments are emitted by ai-service (M4);
  // Node only pipes bytes, so upstream event framing is never corrupted.
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  req.socket.setTimeout(0);

  req.on('close', abort);
  Readable.fromWeb(response.body).pipe(res);
});

/** POST /api/ai/search — Annexe B (query 1..500, limit clamped to 50). */
const search = asyncHandler(async (req, res) => {
  const { query, types, limit = 10 } = req.body || {};
  if (typeof query !== 'string' || query.trim().length < 1 || query.length > 500) {
    return sendValidationError(res, [{ field: 'query', message: 'query must be a string of 1..500 characters' }]);
  }
  // Default: search the whole indexed corpus (documents + public portal, D6).
  // A caller may narrow to a subset, but every value must be a known source type.
  const requestedTypes = types === undefined ? [...AI_SEARCHABLE_SOURCE_TYPES] : types;
  if (!Array.isArray(requestedTypes) || requestedTypes.length === 0
      || requestedTypes.some((t) => !AI_SEARCHABLE_SOURCE_TYPES.includes(t))) {
    return sendValidationError(res, [{
      field: 'types',
      message: `types must be a non-empty subset of [${AI_SEARCHABLE_SOURCE_TYPES.join(', ')}]`,
    }]);
  }
  const clampedLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
  return proxyJson(req, res, '/search', { body: { query: query.trim(), types: requestedTypes, limit: clampedLimit } });
});

/**
 * GET /api/ai/conversations — proxied history list (stored in ai-service),
 * re-wrapped with sendPaginated (Annexe B: data = items, pagination meta).
 */
const listConversations = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);

  let upstream;
  try {
    upstream = await aiService.forward(`/conversations?page=${page}&limit=${limit}`, {
      method: 'GET',
      user: req.user,
      entitlement: req.aiEntitlement,
      campusId: req.aiCampusId,
    });
  } catch (error) {
    return sendUpstreamFailure(res, error);
  }
  const { response } = upstream;
  const payload = await safeJson(response);
  if (!response.ok) {
    return sendError(res, response.status, payload?.detail || payload?.message || 'AI service error');
  }
  return sendPaginated(res, 200, 'OK', payload?.items || [], {
    total: payload?.total || 0,
    page: payload?.page || page,
    limit: payload?.limit || limit,
  });
});

/** GET /api/ai/conversations/:id — proxied conversation detail. */
const getConversation = asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  // Service-side ids are uuids (design §1.2 / Annexe B), not Mongo ObjectIds.
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return sendValidationError(res, [{ field: 'id', message: 'id must be a uuid' }]);
  }
  return proxyJson(req, res, `/conversations/${id}`, { method: 'GET' });
});

/**
 * POST /api/ai/analytics/:report — descriptive summary over ERP aggregates
 * (Annexe B, M5). The report and its params are validated here per report
 * schema (design §8) against the shared aggregate registry; the narrative
 * language claim is the user's preferred locale, like the chat.
 */
const analytics = asyncHandler(async (req, res) => {
  const report = String(req.params.report);
  if (!isKnownAggregate(report)) {
    return sendError(res, 404, `Unknown analytics report '${report}'`);
  }
  const rawParams = req.body?.params;
  if (rawParams !== undefined && (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams))) {
    return sendValidationError(res, [{ field: 'params', message: 'params must be an object' }]);
  }
  const { errors, params } = validateAggregateParams(report, rawParams || {});
  if (errors.length > 0) {
    return sendValidationError(res, errors);
  }
  return proxyJson(req, res, `/analytics/${report}`, {
    body: { params },
    language: await resolvePreferredLanguage(req.user.id),
  });
});

/**
 * POST /api/ai/advisors/:advisor — business advisor proposals (Annexe B,
 * M5b). Strict proposal mode (§6.6): the reply is rendered to a human, the
 * AI never writes an ERP record. Params are whitelisted per advisor (shared
 * registry, same validators as analytics); proposals are narrated in the
 * user's preferred locale, like the chat and the analytics.
 */
const advisors = asyncHandler(async (req, res) => {
  const advisor = String(req.params.advisor);
  if (!isKnownAdvisor(advisor)) {
    return sendError(res, 404, `Unknown advisor '${advisor}'`);
  }
  const rawParams = req.body?.params;
  if (rawParams !== undefined && (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams))) {
    return sendValidationError(res, [{ field: 'params', message: 'params must be an object' }]);
  }
  const { errors, params } = validateAdvisorParams(advisor, rawParams || {});
  if (errors.length > 0) {
    return sendValidationError(res, errors);
  }
  return proxyJson(req, res, `/advisors/${advisor}`, {
    body: { params },
    language: await resolvePreferredLanguage(req.user.id),
  });
});

/**
 * GET /api/ai/usage — campus consumption gauge (Annexe B). Plan and budget
 * come from the campus entitlement (Node source of truth); token counters
 * come from ai-service (usage_monthly, shipped in M3) — until then they are
 * reported as unavailable rather than invented.
 */
const usage = asyncHandler(async (req, res) => {
  const entitlement = req.aiEntitlement;
  const counters = await aiService.fetchMonthlyUsage(req.user, entitlement, req.aiCampusId);
  if (!counters) {
    return sendError(res, 503, 'AI usage counters are not available yet', {
      code: AI_ERROR_CODES.UPSTREAM_TIMEOUT,
    });
  }
  const tokensIn = counters.tokensIn || 0;
  const tokensOut = counters.tokensOut || 0;
  const budget = entitlement.monthlyTokenBudget;
  return sendSuccess(res, 200, 'OK', {
    period: counters.period,
    plan: entitlement.plan,
    tokensIn,
    tokensOut,
    budget,
    remaining: budget > 0 ? Math.max(budget - tokensIn - tokensOut, 0) : null,
  });
});

module.exports = {
  chat,
  search,
  listConversations,
  getConversation,
  analytics,
  advisors,
  usage,
};
