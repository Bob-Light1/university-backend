'use strict';

/**
 * @file ai.internal.routes.js
 * @description Internal ERP read API for ai-service (/internal/ai/*, §6.2).
 *
 * NOT a public surface: mounted OUTSIDE /api (no user JWT), protected by the
 * S2S JWT signed by ai-service (verified on every request — the token is the
 * authority, §4.2). The reverse proxy MUST NOT publish the /internal prefix;
 * network isolation is defense in depth, not the only barrier.
 *
 * A dedicated limiter provides the ingestion backpressure contract (§6.3.1):
 * the ai-service worker backs off on 429 and resumes from its cursor.
 */

const express = require('express');
const { createCustomLimiter } = require('../../shared/middleware/rate-limiter');
const {
  authenticateService,
  listIngestables,
  authorizeCitations,
  getAggregate,
} = require('./ai.internal.controller');

const router = express.Router();

router.use(authenticateService);

// S2S backpressure (§6.3.1): generous for online RAG calls, strict enough to
// keep a runaway ingestion worker from degrading the ERP. Keyed per S2S subject.
const s2sLimiter = createCustomLimiter(1, 300, 'Internal AI rate limit reached. Back off and retry.', {
  prefix: 'ai-internal',
  keyGenerator: (req) => `s2s:${req.s2s.userId}:${req.s2s.campusId}`,
});
router.use(s2sLimiter);

/**
 * @route   GET /internal/ai/ingestables
 * @desc    Cursor-paginated indexable content feed (limit clamped ≤ 200, §6.3.1)
 * @access  S2S (ai-service ingestion worker) — campus scope from the token
 */
router.get('/ingestables', listIngestables);

/**
 * @route   POST /internal/ai/authorize-citations
 * @desc    Batch re-authorization of citations at answer time (§4.5, §6.2)
 * @access  S2S (ai-service RAG/search) — user scope from the token
 */
router.post('/authorize-citations', authorizeCitations);

/**
 * @route   GET /internal/ai/aggregates/:name
 * @desc    Deterministic, PII-free ERP aggregates for the AI analytics (§8)
 * @access  S2S (ai-service) — end-user identity from the token, staffing roles only
 */
router.get('/aggregates/:name', getAggregate);

module.exports = router;
