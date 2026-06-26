'use strict';

/**
 * @file referral.js
 * @description Single source of truth for partner referral URLs and QR targets.
 *
 * The referral link is DERIVED from the partnerCode at read time — never
 * persisted as an authoritative value — so changing the portal base URL
 * re-points every existing partner's link without a data migration, and stale
 * stored values can never be served.
 *
 * Canonical funnel: the public marketing portal (PORTAL_URL). Partners share a
 * short, re-pointable `/r/{code}` link (QR codes encode `/r/{code}?src=qr`); the
 * portal's redirector forwards it to its landing as `?ref=CODE` (+ `src` to tell
 * a scanned QR from a shared link). Keeping the link short and indirect means the
 * landing path can change without reissuing any printed material or QR code.
 */

const DEFAULT_PORTAL_BASE = 'http://localhost:3000';

/**
 * Normalizes a base URL: trims and drops any trailing slash(es) so callers can
 * always append a path that starts with '/'. Prevents the `//path` double-slash
 * bug that arises when the env value ends with a slash.
 * @param {string} url
 * @returns {string}
 */
const normalizeBaseUrl = (url) => String(url || '').trim().replace(/\/+$/, '');

/**
 * Resolves the public portal base URL from the environment. PORTAL_URL is the
 * Next.js marketing portal — the single canonical pre-registration funnel.
 * @returns {string}
 */
const getPortalBase = () => normalizeBaseUrl(process.env.PORTAL_URL || DEFAULT_PORTAL_BASE);

/**
 * Builds the public short referral URL a partner shares to drive pre-registrations:
 * `${PORTAL}/r/{CODE}`. Derived solely from the partnerCode; pass `{ src: 'qr' }`
 * for the QR-encoded variant (`?src=qr`) so scan-vs-click attribution can be
 * distinguished downstream. The portal's `/r/{code}` route redirects to its
 * landing carrying `?ref=CODE` (+ `src`).
 *
 * @param {string} code — partnerCode
 * @param {{ src?: string }} [opts]
 * @returns {string|null} null when no code is provided
 */
const buildReferralUrl = (code, { src } = {}) => {
  if (!code) return null;
  const slug = encodeURIComponent(String(code).toUpperCase().trim());
  const query = src ? `?src=${encodeURIComponent(src)}` : '';
  return `${getPortalBase()}/r/${slug}${query}`;
};

module.exports = {
  normalizeBaseUrl,
  getPortalBase,
  buildReferralUrl,
};
