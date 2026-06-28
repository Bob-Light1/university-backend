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
 * The X-Portal-Key is held server-side by the Next.js portal proxy and never
 * reaches the browser. Defense in depth = restricted CORS + per-visitor rate
 * limiting (keyed off the portal-forwarded client IP, see resolvePortalClientIp).
 *
 * Key rotation: the ERP accepts ANY key listed in `PORTAL_API_KEYS` (comma-
 * separated), falling back to the single `PORTAL_API_KEY` for backward
 * compatibility. To rotate without downtime: (1) add the new key alongside the
 * old one in `PORTAL_API_KEYS` and deploy the ERP, (2) switch the portal to the
 * new key, (3) drop the old key from `PORTAL_API_KEYS`. This bounds the blast
 * radius of a leaked key — it can be retired immediately without an outage.
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

/**
 * Accepted portal keys, parsed once at load. `PORTAL_API_KEYS` (comma-separated)
 * takes precedence; otherwise the legacy single `PORTAL_API_KEY` is used. Empty
 * entries and duplicates are dropped.
 *
 * @returns {string[]}
 */
const parsePortalKeys = () => {
  const raw = process.env.PORTAL_API_KEYS || process.env.PORTAL_API_KEY || '';
  return [...new Set(raw.split(',').map((k) => k.trim()).filter(Boolean))];
};

const ACCEPTED_PORTAL_KEYS = parsePortalKeys();

/**
 * True when the provided key matches any accepted key. Every candidate is
 * checked (no short-circuit) so the comparison time does not reveal which slot
 * matched.
 *
 * @param {string} provided
 * @returns {boolean}
 */
const isValidPortalKey = (provided) => {
  let matched = false;
  for (const key of ACCEPTED_PORTAL_KEYS) {
    if (safeEqual(provided, key)) matched = true;
  }
  return matched;
};

/**
 * Resolves the real visitor IP for /api/public/* requests.
 *
 * The portal — the only legitimate caller, already authenticated by the
 * X-Portal-Key check above — forwards the original client IP in `X-Real-IP`
 * and as the first entry of `X-Forwarded-For`. Without honoring it, Express
 * `req.ip` resolves to the portal's egress IP (the actual TCP peer behind the
 * single trusted proxy hop), which would collapse every visitor onto one
 * rate-limit bucket and trip IP_BURST fraud detection for everyone. We
 * therefore prefer the portal-supplied header and fall back to `req.ip`.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
const resolvePortalClientIp = (req) => {
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }

  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  return req.ip || req.connection?.remoteAddress || '';
};

/**
 * True when the portal forwarded the real visitor IP (client-proxied call).
 * Server-side rendering reads hit the ERP directly from the portal egress IP
 * with no such header — read limiters skip those so SSR is never throttled.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
const hasForwardedClientIp = (req) => {
  const realIp    = req.headers['x-real-ip'];
  const forwarded = req.headers['x-forwarded-for'];
  return Boolean(
    (typeof realIp === 'string' && realIp.trim()) ||
    (typeof forwarded === 'string' && forwarded.trim()),
  );
};

const publicPortalMiddleware = (req, res, next) => {
  // Fail-closed: if no key is configured on the ERP side, deny everything.
  if (ACCEPTED_PORTAL_KEYS.length === 0) {
    return sendError(res, 503, 'Public portal is not configured.');
  }

  const portalKey = req.headers['x-portal-key'];

  if (!portalKey || !isValidPortalKey(portalKey)) {
    return sendError(res, 401, 'Missing or invalid portal key.');
  }

  // Resolve the real visitor IP (see resolvePortalClientIp). Both the hashed IP
  // (controllers read req.ipHash, never req.ip) and the public rate limiters
  // (which read req.portalClientIp) are keyed off this value.
  req.portalClientIp        = resolvePortalClientIp(req);
  req.ipHash                = hashIp(req.portalClientIp);
  req.hasForwardedClientIp  = hasForwardedClientIp(req);

  next();
};

module.exports = publicPortalMiddleware;
module.exports.resolvePortalClientIp = resolvePortalClientIp;
module.exports.hasForwardedClientIp  = hasForwardedClientIp;
module.exports.parsePortalKeys       = parsePortalKeys;
