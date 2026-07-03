'use strict';

/**
 * @file ai.internal.controller.js
 * @description Controllers of the internal ERP read API consumed only by
 * ai-service (§6.2). Mirrors the M1 approach on the Python side: the URL
 * surface and the S2S authentication are locked from M2 onwards, and each
 * endpoint answers 501 with the milestone that implements it. The real
 * implementations (M3+) will read the ERP exclusively through the existing
 * module service facades (document.service, result.service, …) and re-apply
 * campus AND intra-campus isolation from the verified S2S token (§4.1.4).
 */

const { sendError, sendUnauthorized, asyncHandler } = require('../../shared/utils/response-helpers');
const { verifyServiceToken } = require('./ai.s2s');
const aiService = require('./ai.service');

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

const MILESTONES = {
  ingestables: 'M3',
  'authorize-citations': 'M3',
  aggregates: 'M5',
};

/** Builds a 501 stub handler carrying the target milestone (same spirit as ai-service stubs.py). */
const notImplemented = (feature) =>
  asyncHandler(async (req, res) => {
    return sendError(res, 501, `'${feature}' is not implemented yet (planned for ${MILESTONES[feature]})`);
  });

/** GET /internal/ai/ingestables — paginated ingestion feed (contract §6.3.1, limit clamped ≤ 200). */
const listIngestables = notImplemented('ingestables');

/** POST /internal/ai/authorize-citations — batch re-authorization at answer time (§6.2, §4.5). */
const authorizeCitations = notImplemented('authorize-citations');

/** GET /internal/ai/aggregates/:name — deterministic ERP aggregates for analytics/engine (§6.5). */
const getAggregate = notImplemented('aggregates');

module.exports = {
  authenticateService,
  listIngestables,
  authorizeCitations,
  getAggregate,
};
