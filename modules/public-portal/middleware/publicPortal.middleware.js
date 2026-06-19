'use strict';

/**
 * @file publicPortal.middleware.js
 * @description Middleware dedicated to /api/public/* endpoints.
 *
 * Responsibilities:
 *  1. Verifies the X-Portal-Key header (identifies the portal as a known source)
 *  2. Hashes the IP in SHA-256 and attaches it to req.ipHash (never the raw IP in DB)
 *
 * This middleware must be mounted BEFORE JWT authentication middlewares
 * since these routes are public (no JWT required).
 *
 * Known limitation: X-Portal-Key is visible in browser JS.
 * Real protection = restricted CORS + rate limiting on the ERP side.
 */

const crypto = require('crypto');
const { sendError } = require('../../../shared/utils/response-helpers');

const hashIp = (ip) => crypto.createHash('sha256').update(ip || '').digest('hex');

// Constant-time comparison — prevents timing attacks on the key.
const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

const publicPortalMiddleware = (req, res, next) => {
  const expectedKey = process.env.PORTAL_API_KEY;

  // Fail-closed: if the key is not configured on the ERP side, deny everything.
  if (!expectedKey) {
    return sendError(res, 503, 'Public portal is not configured.');
  }

  const portalKey = req.headers['x-portal-key'];

  if (!portalKey || !safeEqual(portalKey, expectedKey)) {
    return sendError(res, 401, 'Missing or invalid portal key.');
  }

  // Hash the IP — controllers read req.ipHash, never req.ip directly
  const rawIp  = req.ip || req.connection?.remoteAddress || '';
  req.ipHash   = hashIp(rawIp);

  next();
};

module.exports = publicPortalMiddleware;
