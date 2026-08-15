'use strict';

/**
 * @file entitlement.js
 * @description The server-side gate — one middleware, mounted per router, that
 * turns a resolved entitlement into an HTTP answer.
 *
 * Design doc §7.1. Phase 1 deliverable 1.5/1.6.
 *
 * | Situation                        | Answer                              |
 * |----------------------------------|-------------------------------------|
 * | `enabled`                        | passes                              |
 * | `read_only` and method ≠ GET     | 403 `FEATURE_READ_ONLY`             |
 * | `read_only` and GET              | passes                              |
 * | `hidden`                         | 403 `FEATURE_DISABLED`              |
 * | unknown / missing key            | passes — fail-open (§4.3)           |
 *
 * The dedicated error codes are not decoration: a bare 403 is indistinguishable
 * from a role refusal, and the frontend needs to tell them apart to handle the
 * write-in-flight case (a user with the Finance page already open when the
 * module is switched off, §8.3).
 *
 * NO CONTROLLER KNOWS THIS SYSTEM EXISTS. The gate sits on the router mount and
 * nowhere else, which is what keeps the maintenance cost of 26 modules at one
 * registry entry each.
 *
 * ⚠️ NOT A SECURITY CONTROL. It replaces neither authentication, nor the role
 * check, nor campus isolation. A hidden module protects against clutter, not
 * against an attacker — and it fails OPEN by design (§4.3).
 */

const { sendError } = require('../utils/response-helpers');
const { FEATURE_STATES, FEATURE_ERROR_CODES, FEATURE_REGISTRY } = require('../constants/features.constants');
const { getFeatureState } = require('../utils/entitlement');
const { optionalAuth } = require('./auth');
const entitlementService = require('../lib/entitlement/entitlement.service');

/** Roles bound by no entitlement — they navigate the whole estate (§5.2). */
const GLOBAL_ROLES = Object.freeze(['ADMIN', 'DIRECTOR']);

/** HTTP methods that only read. Everything else counts as a mutation. */
const READ_METHODS = Object.freeze(['GET', 'HEAD', 'OPTIONS']);

/**
 * Builds the gate for one registry key.
 *
 * @param {string} key - Key of `FEATURE_REGISTRY`.
 * @returns {Function} Express middleware.
 */
const requireFeature = (key) => async (req, res, next) => {
  // The gate is mounted at APP level, ahead of every router — and each router
  // runs its own `authenticate` internally, so `req.user` is not populated yet
  // when we get here. `optionalAuth` reads the token with the same algorithm
  // and issuer pinning as `authenticate` and never refuses a request, so the
  // gate can see the identity without taking over authentication: an invalid
  // or absent token still gets its 401 from the router, not from here.
  if (!req.user) await new Promise((resolve) => optionalAuth(req, res, resolve));

  // Unauthenticated surfaces (the public portal) carry no campus in a JWT: the
  // campus comes from a slug or a route parameter there, which is the phase 5
  // deliverable (§9.2). Until then they pass — never guessed, never refused.
  if (!req.user) return next();

  // Global roles see every campus, including its disabled modules (they are
  // shown with a "disabled for this campus" badge rather than removed, §5.2).
  if (GLOBAL_ROLES.includes(req.user.role)) return next();

  const campusId = req.user.campusId;
  if (!campusId) return next();   // fail-open — auth owns the missing-campus case

  let resolved;
  try {
    resolved = await entitlementService.resolveForCampus(String(campusId));
  } catch {
    // Fail-open (§4.3): the platform working with too many modules visible is a
    // support ticket; the platform refusing every route because a lookup failed
    // is an outage. The inversion is deliberate — see the file header.
    return next();
  }

  const state = getFeatureState(resolved, key);
  const label = FEATURE_REGISTRY[key]?.label || key;

  if (state === FEATURE_STATES.HIDDEN) {
    return sendError(res, 403, `The '${label}' module is not enabled for this campus`, {
      code: FEATURE_ERROR_CODES.FEATURE_DISABLED,
      feature: key,
    });
  }

  if (state === FEATURE_STATES.READ_ONLY && !READ_METHODS.includes(req.method)) {
    return sendError(res, 403, `The '${label}' module is currently read-only for this campus`, {
      code: FEATURE_ERROR_CODES.FEATURE_READ_ONLY,
      feature: key,
    });
  }

  req.entitlement = resolved;
  return next();
};

/**
 * Mounts one gate per router path declared in the registry.
 *
 * Derived from `FEATURE_REGISTRY[key].routers` rather than hand-written line by
 * line in `app.js`: the mount paths are already declared there, and
 * `tests/unit/feature-registry.test.js` already fails when `app.js` mounts a
 * router the registry does not know. Repeating the list in `app.js` would give
 * that guarantee a second, unpinned source of truth (CLAUDE.md §0.1) — and the
 * failure mode of a forgotten line is the silent one: a module that ignores the
 * campus that switched it off.
 *
 * Mounted as PATH-SCOPED middleware, ahead of the routers themselves. Three
 * modules (`student`, `teacher`, `staff`) mount their router on the bare `/api`
 * and expose several prefixes from inside; gating them at their mount point
 * would put the gate in front of the entire API surface.
 *
 * @param {import('express').Application} app
 * @returns {number} number of gates mounted — logged at boot.
 */
const mountEntitlementGates = (app) => {
  let mounted = 0;
  for (const [key, entry] of Object.entries(FEATURE_REGISTRY)) {
    for (const routerPath of entry.routers || []) {
      app.use(routerPath, requireFeature(key));
      mounted += 1;
    }
  }
  return mounted;
};

module.exports = { requireFeature, mountEntitlementGates, GLOBAL_ROLES, READ_METHODS };
