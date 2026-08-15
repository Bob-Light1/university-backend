'use strict';

/**
 * @file entitlement.cache.js
 * @description In-process cache of resolved entitlements — NOT an optimisation,
 * a precondition (design doc §7.2).
 *
 * The AI gate reads `Campus.aiEntitlement` from Mongo on every AI request. That
 * is affordable for one module; generalised to 26, the same design would add a
 * database round-trip to EVERY API call of the platform. The entitlement of a
 * campus changes a few times a year and is read thousands of times a day.
 *
 * ⚠️ KNOWN LIMIT, documented rather than hidden: in a multi-process deployment,
 * `bump()` only clears the process that served the PATCH. The other workers keep
 * serving their own entry until it expires, so a change can take up to
 * {@link TTL_MS} to become visible everywhere. That window is acceptable
 * precisely because entitlement is packaging and not a security boundary (§4.3)
 * — the same window on a campus filter would be unacceptable. A distributed
 * invalidator (Redis pub/sub) is the upgrade path if that ever stops holding;
 * it is deliberately out of scope for v1 (§16.1).
 */

/** Time an entry stays trusted without being re-read. */
const TTL_MS = 60 * 1000;

/**
 * Hard ceiling on entries. Campus counts are small, but the key comes from a
 * request, so an unbounded Map is an unbounded memory footprint for anyone
 * willing to send junk campus ids. On overflow the oldest insertion goes —
 * Map preserves insertion order, so the first key is the coldest.
 */
const MAX_ENTRIES = 1000;

/** @type {Map<string, {resolved: Object, expiresAt: number}>} */
const store = new Map();

/**
 * @param {string} campusId
 * @param {number} [now]
 * @returns {Object|null} the cached resolved entitlement, or null on miss/expiry.
 */
const get = (campusId, now = Date.now()) => {
  const hit = store.get(campusId);
  if (!hit) return null;
  if (hit.expiresAt <= now) {
    store.delete(campusId);
    return null;
  }
  return hit.resolved;
};

/**
 * @param {string} campusId
 * @param {Object} resolved - Frozen output of `resolveEntitlement()`.
 * @param {number} [now]
 */
const set = (campusId, resolved, now = Date.now()) => {
  if (store.size >= MAX_ENTRIES && !store.has(campusId)) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(campusId, { resolved, expiresAt: now + TTL_MS });
};

/**
 * Drops one campus after a mutation. Called by the service on every write —
 * never by a controller, so a new entitlement route cannot forget it.
 * @param {string} campusId
 */
const bump = (campusId) => {
  store.delete(String(campusId));
};

/** Empties the cache. Tests and graceful shutdown only. */
const clear = () => store.clear();

/** @returns {number} current entry count — exposed for the health probe (§12). */
const size = () => store.size;

module.exports = { TTL_MS, MAX_ENTRIES, get, set, bump, clear, size };
