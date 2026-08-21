'use strict';

/**
 * @file entitlement.js
 * @description Per-campus entitlement RESOLVER — turns the stored, sparse
 * `Campus.entitlement` document into a flat `{ key → state }` map the gate and
 * the frontend can read without knowing any rule.
 *
 * Design doc: `docs/architecture/CAMPUS_ENTITLEMENT_DESIGN.md` §4.2 (precedence)
 * and §4.3 (fail-open). Phase 1 deliverable 1.3.
 *
 * PURE ON PURPOSE — no Mongoose, no cache, no I/O, no `Date.now()` outside the
 * injected `now`. It takes RAW DATA (a `.lean()` sub-document or a plain object)
 * and returns a frozen plain object. Two reasons:
 *   1. §15bis.3 — the day the platform moves to PostgreSQL, only
 *      `campus.repository.js` changes; this file, the middleware and the 26
 *      routers do not move.
 *   2. It is the one place where the precedence order is written, so it must be
 *      testable without a database.
 *
 * ⚠️ FAIL-OPEN — deliberate inversion of the house convention.
 * `buildCampusFilter()` and `notDeletedFilter()` fail CLOSED because they are
 * security boundaries: an empty filter there is a data leak. Entitlement is
 * commercial packaging, not a security control, so an UNKNOWN or MISSING key
 * resolves to `enabled` (design doc §4.3). Without this, the first deployment
 * would switch every module off on every existing campus, and any module added
 * to the code before its registry entry would be invisible in production.
 * Do not "fix" this by analogy with the two helpers above.
 */

const {
  FEATURE_STATES,
  STATE_RANK,
  FEATURE_KEYS,
  FEATURE_REGISTRY,
  PLAN_PRESETS,
  DEFAULT_QUOTAS,
} = require('../constants/features.constants');

/** Layer that posted an override — the offer (ADMIN) or the usage (CAMPUS_MANAGER). */
const OVERRIDE_LAYERS = Object.freeze({
  ADMIN:  'admin',
  CAMPUS: 'campus',
});

/**
 * Everything on, no plan. The answer whenever entitlement data is missing:
 * a campus created before this system, a campus id that no longer resolves, an
 * unauthenticated surface. Fail-open (§4.3).
 */
const ALL_ENABLED = Object.freeze({
  plan: null,
  features: Object.freeze(
    FEATURE_KEYS.reduce((acc, key) => { acc[key] = FEATURE_STATES.ENABLED; return acc; }, {})
  ),
  quotas: null,
  ai: null,
});

/**
 * Whether a stored override still applies at `now`.
 * `until` is evaluated AT READ TIME — there is no expiry cron and no state to
 * reconcile (§4.2). An expired override is simply ignored, so the effective
 * state falls back to the layer underneath it.
 *
 * @param {Object} override - One `entitlement.modules[]` entry.
 * @param {Date}   now
 * @returns {boolean}
 */
const isOverrideActive = (override, now) => {
  if (!override || !FEATURE_KEYS.includes(override.key)) return false;
  if (!Object.values(FEATURE_STATES).includes(override.state)) return false;
  if (!override.until) return true;
  return new Date(override.until).getTime() > now.getTime();
};

/**
 * Base state granted by the plan alone, before any override.
 *
 *  - no plan recorded  → ENABLED (fail-open: the campus predates the system);
 *  - `custom`          → HIDDEN, because a custom offer is defined entirely by
 *                        its explicit overrides and grants nothing implicitly;
 *  - a known tier      → ENABLED when the tier includes the key, else HIDDEN.
 *
 * @param {string|null|undefined} plan
 * @param {string} key
 * @returns {string} one of FEATURE_STATES
 */
const planBaseState = (plan, key) => {
  if (!plan) return FEATURE_STATES.ENABLED;
  const preset = PLAN_PRESETS[plan];
  if (!preset) return FEATURE_STATES.HIDDEN;   // `custom`, or an unknown tier
  return preset.includes(key) ? FEATURE_STATES.ENABLED : FEATURE_STATES.HIDDEN;
};

/**
 * Resolves the effective state of every registered feature for one campus.
 *
 * Precedence (§4.2), in order:
 *   1. plan preset — the base;
 *   2. `setBy: 'admin'` overrides — the OFFER layer, free to raise or lower;
 *   3. `setBy: 'campus'` overrides — the USAGE layer, may only ever LOWER
 *      (a manager can decline part of the offer, never grant themselves more);
 *   4. expired `until` — the override is skipped entirely;
 *   5. `core` — forced back to ENABLED whatever anyone wrote, so nobody can
 *      lock themselves out of the screen that switches things back on (§5.1).
 *
 * @param {Object|null|undefined} entitlementData - RAW `campus.entitlement`.
 * @param {Object} [options]
 * @param {Date}   [options.now] - Injected clock, for deterministic tests.
 * @returns {{plan: string|null, features: Object, quotas: Object|null, ai: Object|null}}
 *   Frozen — the result is shared through the cache and must not be mutated.
 */
const resolveEntitlement = (entitlementData, { now = new Date() } = {}) => {
  if (!entitlementData) return ALL_ENABLED;

  const plan = entitlementData.plan || null;
  const overrides = Array.isArray(entitlementData.modules) ? entitlementData.modules : [];

  const features = {};
  for (const key of FEATURE_KEYS) features[key] = planBaseState(plan, key);

  // 2. Offer layer — assignment, not clamping: this is where a module outside
  // the plan is granted (an upsell, a pilot, a grandfathered campus).
  for (const override of overrides) {
    if (override.setBy === OVERRIDE_LAYERS.CAMPUS) continue;
    if (!isOverrideActive(override, now)) continue;
    features[override.key] = override.state;
  }

  // 3. Usage layer — clamped DOWN against the offer. A campus override that
  // tries to raise the state is not an error, it is simply inert: the offer is
  // the ceiling (§5). Validating it at write time is the guard's job; resolving
  // it safely here means a stale row can never widen an offer either.
  for (const override of overrides) {
    if (override.setBy !== OVERRIDE_LAYERS.CAMPUS) continue;
    if (!isOverrideActive(override, now)) continue;
    if (STATE_RANK[override.state] < STATE_RANK[features[override.key]]) {
      features[override.key] = override.state;
    }
  }

  // 5. Core floor — last, so it wins over every layer above.
  for (const key of FEATURE_KEYS) {
    if (FEATURE_REGISTRY[key].core) features[key] = FEATURE_STATES.ENABLED;
  }

  return Object.freeze({
    plan,
    features: Object.freeze(features),
    quotas: entitlementData.quotas || null,
    ai: entitlementData.ai || null,
  });
};

/**
 * Effective state of one key. An unregistered key resolves to ENABLED —
 * fail-open (§4.3), not a lookup failure.
 *
 * @param {Object} resolved - Output of {@link resolveEntitlement}.
 * @param {string} key
 * @returns {string} one of FEATURE_STATES
 */
const getFeatureState = (resolved, key) =>
  resolved?.features?.[key] ?? FEATURE_STATES.ENABLED;

/**
 * Whether a request may proceed.
 *
 * @param {Object}  resolved
 * @param {string}  key
 * @param {Object}  [options]
 * @param {boolean} [options.write=false] - true for a mutation. `read_only`
 *   passes reads and refuses writes; that asymmetry is the whole point of the
 *   state (§4.1) — freezing a module must never amputate its history.
 * @returns {boolean}
 */
const isFeatureActive = (resolved, key, { write = false } = {}) => {
  const state = getFeatureState(resolved, key);
  if (state === FEATURE_STATES.HIDDEN) return false;
  if (state === FEATURE_STATES.READ_ONLY) return !write;
  return true;
};

/**
 * Effective value of one capacity ceiling for a campus (design doc §9.3).
 *
 * Three sources, in order — `entitlement.quotas` (what was sold), the legacy
 * `features` object (what was sold before the unification, §3.2), then
 * {@link DEFAULT_QUOTAS}. The legacy step is not decoration: until
 * `scripts/migrate-entitlement.js` has run on the estate, `entitlement` is
 * absent everywhere and the second source is the ONLY one carrying a campus's
 * real ceiling. Dropping it would silently reset every negotiated quota to the
 * default the day this code shipped.
 *
 * A stored value that is not a usable ceiling (0, negative, non-numeric) falls
 * through to the next source rather than being applied: a quota of 0 does not
 * mean "unlimited" anywhere in this system, it means nobody can create
 * anything, and that is never what a missing configuration should express.
 *
 * PURE — takes the campus document (full or `.lean()`), returns a number.
 *
 * @param {Object|null|undefined} campus - `{ entitlement, features }`.
 * @param {string} name - One of the {@link DEFAULT_QUOTAS} keys.
 * @param {Object} [options]
 * @param {number} [options.fallback] - Deployment-level default replacing the
 *   built-in one (the GED reads `DOC_DEFAULT_STORAGE_QUOTA_MB` this way). It
 *   sits at the END of the chain on purpose: an environment variable is a knob
 *   for a deployment, never a way to overrule what a tenant was sold.
 * @returns {number}
 * @throws {Error} on an undeclared quota name — a typo must not resolve to
 *   `undefined` and become an unbounded comparison (`n < undefined` is false,
 *   so every creation would be refused with no message saying why).
 */
const resolveQuota = (campus, name, { fallback } = {}) => {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_QUOTAS, name)) {
    throw new Error(`resolveQuota: unknown quota '${name}'`);
  }
  const usable = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

  const fromEntitlement = campus?.entitlement?.quotas?.[name];
  if (usable(fromEntitlement)) return fromEntitlement;

  const fromLegacy = campus?.features?.[name];
  if (usable(fromLegacy)) return fromLegacy;

  return usable(fallback) ? fallback : DEFAULT_QUOTAS[name];
};

module.exports = {
  OVERRIDE_LAYERS,
  ALL_ENABLED,
  isOverrideActive,
  planBaseState,
  resolveEntitlement,
  getFeatureState,
  isFeatureActive,
  resolveQuota,
};
