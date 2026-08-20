'use strict';

/**
 * @file ai.service.js
 * @description HTTP client towards the ai-service (ADR-2). The ONLY file that
 * talks to the AI micro-service; controllers never build requests themselves.
 *
 * Every outgoing call carries a short-lived S2S JWT signed by ai.s2s.js — the
 * campus/user context travels in the token, never in the payload (§4.1).
 * The module is INERT when AI_SERVICE_URL / AI_SERVICE_SECRET are missing:
 * isEnabled() gates every route (503 AI_DISABLED, zero external call).
 */

const crypto = require('crypto');
const config = require('../../shared/configs/general.config');
const { signServiceToken } = require('./ai.s2s');
const { resolveAiEntitlement } = require('../../shared/lib/entitlement/entitlement.ai');

/** Correlation header shared with ai-service (mirrors REQUEST_ID_HEADER). */
const REQUEST_ID_HEADER = 'X-Request-Id';

/** Whether the AI gateway is configured (§11.1 — empty URL = module inert). */
const isEnabled = () => Boolean(config.ai.serviceUrl && config.ai.serviceSecret);

/**
 * Builds the S2S signing context from the authenticated user + resolved
 * campus entitlement (set by the entitlement middleware).
 * @param {Object} user - req.user ({ id, role, campusId }).
 * @param {Object} entitlement - req.aiEntitlement ({ plan, llmProfile, monthlyTokenBudget }).
 * @param {string|null} [campusId] - Effective campus scope (may differ from
 *   user.campusId for global roles acting on a specific campus).
 * @param {string} [language] - User preferred locale (drives the chat reply
 *   language service-side, M4).
 */
const buildTokenContext = (user, entitlement, campusId = null, language = 'en') => ({
  userId: user.id,
  campusId: campusId ?? user.campusId ?? '',
  role: user.role,
  plan: entitlement?.plan || 'free',
  llmProfile: entitlement?.llmProfile || 'free',
  language,
  monthlyTokenBudget: entitlement?.monthlyTokenBudget || 0,
});

/**
 * Performs an authenticated request to ai-service and returns the raw fetch
 * Response (the controller decides between JSON pass-through and SSE piping).
 *
 * The timeout only guards the time-to-headers: once the upstream responded,
 * the abort controller is handed back to the caller so a streaming body can
 * outlive the timeout and be aborted on client disconnect (§6.1).
 *
 * @param {string} path - ai-service path (e.g. '/chat').
 * @param {Object} opts
 * @param {string} [opts.method='POST']
 * @param {Object} [opts.body] - JSON payload (business params only — no ids of scope).
 * @param {Object} opts.user - req.user.
 * @param {Object} [opts.entitlement] - req.aiEntitlement.
 * @param {string|null} [opts.campusId] - Effective campus scope override.
 * @param {string} [opts.language] - User preferred locale (S2S claim, M4).
 * @param {string} [opts.requestId] - Correlation id echoed in ai-service logs
 *   and returned on the response (M6, §10); generated when omitted.
 * @returns {Promise<{ response: Response, abort: () => void, requestId: string }>}
 */
const forward = async (path, {
  method = 'POST', body, user, entitlement, campusId = null, language = 'en',
  requestId,
} = {}) => {
  if (!isEnabled()) {
    throw new Error('AI service is not configured');
  }
  const token = signServiceToken(buildTokenContext(user, entitlement, campusId, language));
  const correlationId = requestId || crypto.randomUUID();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ai.requestTimeoutMs);

  try {
    const response = await fetch(new URL(path, config.ai.serviceUrl), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        [REQUEST_ID_HEADER]: correlationId,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    return { response, abort: () => controller.abort(), requestId: correlationId };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Fire-and-forget ingestion signal towards ai-service (§6.3) — called by the
 * document module and the public-portal back-office on publication-state
 * changes (same spirit as the notification emitters). Never throws, never
 * blocks the caller's response.
 *
 * The signal is skipped when the campus has not subscribed to AI — the per-campus
 * opt-out (D7). Since phase 2 of CAMPUS_ENTITLEMENT_DESIGN.md that subscription
 * is the state of the `ai` key in the unified entitlement, read through the same
 * `resolveAiEntitlement()` as the request gate rather than re-derived here: an
 * unsubscribed campus must never be indexed, and "unsubscribed" has to mean the
 * same thing on the ingestion path as on the query path.
 *
 * @param {Object} p
 * @param {string|Object} p.campusId - Campus owning the source.
 * @param {string|Object} p.sourceId - ERP id of the source.
 * @param {string} [p.sourceType='document'] - Any AI_INGESTABLE_SOURCE_TYPES value.
 * @returns {Promise<boolean>} true when the signal was accepted upstream.
 */
const signalIngest = async ({ campusId, sourceId, sourceType = 'document' }) => {
  if (!isEnabled()) return false;
  try {
    // Lazy require: campus is a module hub (see the note in its facade).
    const campus = await require('../campus').service.getCampusAiEntitlement(String(campusId));
    if (campus?.status !== 'active') return false;
    const entitlement = resolveAiEntitlement(campus);
    if (!entitlement.enabled) return false;

    const { response } = await forward('/ingest', {
      body: { sourceType, sourceId: String(sourceId) },
      // Machine subject: a scoped (non-global) role bound to the campus —
      // ai-service derives the ingestion scope from this token (§4.2).
      user: { id: 'system-ingest-signal', role: 'SERVICE', campusId: String(campusId) },
      entitlement,
      campusId: String(campusId),
    });
    return response.ok;
  } catch (error) {
    console.warn(`🤖 [ai] ingest signal failed for ${sourceType}:${sourceId}: ${error.message}`);
    return false;
  }
};

/**
 * Back-compat alias: the document module historically calls
 * signalDocumentIngest; the signal is source-type agnostic (defaults to
 * 'document'), so both names point at the same implementation.
 */
const signalDocumentIngest = signalIngest;

/**
 * Monthly token usage for a campus (budget gate + /api/ai/usage).
 * Returns null when the endpoint is not available yet (ai-service ships it in
 * M3) or the service is unreachable — callers decide how to degrade. Node
 * failing open here is acceptable: ai-service re-checks the budget itself
 * before every LLM call (defense in depth, §11.3).
 *
 * @param {Object} user - req.user (acts as the S2S subject).
 * @param {Object} entitlement - Resolved campus entitlement.
 * @param {string} campusId - Campus whose usage is read.
 * @returns {Promise<{ period: string, tokensIn: number, tokensOut: number }|null>}
 */
const fetchMonthlyUsage = async (user, entitlement, campusId) => {
  try {
    const { response } = await forward('/usage', { method: 'GET', user, entitlement, campusId });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
};

module.exports = {
  isEnabled,
  forward,
  signalIngest,
  signalDocumentIngest,
  fetchMonthlyUsage,
};
