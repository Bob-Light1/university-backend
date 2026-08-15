'use strict';

/**
 * @file settings.entitlement.controller.js
 * @description Hydration endpoint for the frontend entitlement context.
 *
 *   GET /api/settings/entitlement → the EFFECTIVE feature states of the caller.
 *
 * Design doc §8.1. It lives here rather than in the nine login controllers on
 * purpose: injecting the flags into the login response would multiply by nine
 * the surface to change and the contracts to keep in step (admin, campus,
 * student, teacher, parent, mentor, staff, partner, S2S), for no gain — the
 * frontend fetches it once after login through its `EntitlementProvider`.
 *
 * The response carries STATES, never rules: the frontend renders what it is
 * told and re-implements no access logic (§8.2). Whoever changes a rule changes
 * it here, once.
 */

const { sendSuccess, sendValidationError, asyncHandler } = require('../../../shared/utils/response-helpers');
const { isValidObjectId } = require('../../../shared/utils/validation-helpers');
const { FEATURE_STATES, FEATURE_REGISTRY, FEATURE_KEYS } = require('../../../shared/constants/features.constants');
const entitlement = require('../../../shared/lib/entitlement');

/** Roles bound by no entitlement — see the gate (§5.2). */
const GLOBAL_ROLES = Object.freeze(['ADMIN', 'DIRECTOR']);

/** Registry metadata the UI needs to render a module, minus every rule. */
const describeRegistry = () =>
  FEATURE_KEYS.reduce((acc, key) => {
    const entry = FEATURE_REGISTRY[key];
    acc[key] = { label: entry.label, core: entry.core, minPlan: entry.minPlan };
    return acc;
  }, {});

/**
 * GET /api/settings/entitlement
 *
 * Scoped roles get their own campus, always — `campusId` is never read from the
 * request (CLAUDE.md §2). Global roles get the whole estate enabled, narrowed
 * by an optional `?campusId=` when they navigate inside a tenant context, which
 * is what lets an admin see a campus exactly as its manager does.
 *
 * @access Authenticated (any role)
 */
const getEntitlement = asyncHandler(async (req, res) => {
  const isGlobal = GLOBAL_ROLES.includes(req.user.role);
  const requested = req.query.campusId;

  if (isGlobal && requested !== undefined && requested !== '' && !isValidObjectId(String(requested))) {
    // Rejected rather than ignored: falling back to the platform view would
    // answer a campus-scoped question with a platform-scoped answer, and the
    // admin would see modules the campus does not have.
    return sendValidationError(res, [{ field: 'campusId', message: 'campusId must be a valid ObjectId' }]);
  }

  const campusId = isGlobal
    ? (requested && String(requested)) || null
    : (req.user.campusId && String(req.user.campusId)) || null;

  const resolved = campusId
    ? await entitlement.service.resolveForCampus(campusId)
    : entitlement.service.ALL_ENABLED;

  return sendSuccess(res, 200, 'OK', {
    campusId,
    // A global role browsing without a campus context is not "on the free plan":
    // it is on no plan at all, and the UI must not render a tier badge for it.
    plan: resolved.plan,
    unrestricted: isGlobal,
    states: Object.values(FEATURE_STATES),
    features: resolved.features,
    registry: describeRegistry(),
  });
});

module.exports = { getEntitlement };
