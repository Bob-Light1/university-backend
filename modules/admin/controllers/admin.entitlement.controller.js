'use strict';

/**
 * @file admin.entitlement.controller.js
 * @description The OFFER layer of the per-campus entitlement
 * (CAMPUS_ENTITLEMENT_DESIGN.md §5) — what a campus has the RIGHT to use.
 * ADMIN / DIRECTOR only.
 *
 *   GET   /api/admin/campuses/:id/entitlement → offer, effective state, audit
 *   PATCH /api/admin/campuses/:id/entitlement → plan and/or module overrides
 *
 * The `plan` written here is the pivot a billing module will consume — single
 * source of truth, deliberately the same tier vocabulary as the AI grid (D-D).
 *
 * Generalises `admin.ai-entitlement.controller.js`, which stays in place until
 * the AI module is absorbed in phase 2. Campus data is reached through the
 * campus facade and the entitlement service; no model is touched here.
 */

const {
  sendSuccess,
  sendNotFound,
  sendValidationError,
  asyncHandler,
} = require('../../../shared/utils/response-helpers');
const { isValidObjectId } = require('../../../shared/utils/validation-helpers');
const { PLAN_PRESETS, FEATURE_PLANS } = require('../../../shared/constants/features.constants');
const { OVERRIDE_LAYERS } = require('../../../shared/utils/entitlement');
const entitlement = require('../../../shared/lib/entitlement');
const { resolveAiEntitlement } = require('../../../shared/lib/entitlement/entitlement.ai');
const {
  applyAndRespond,
  PILOT_REQUIREMENTS,
} = require('../../../shared/lib/entitlement/entitlement.controller');

/**
 * GET /api/admin/campuses/:id/entitlement
 * Everything the admin console needs for one campus: per-feature effective
 * state, what the plan alone would give, the override in force if any, and the
 * recent audit entries.
 *
 * @access ADMIN | DIRECTOR
 */
const getCampusEntitlement = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return sendValidationError(res, [{ field: 'id', message: 'Invalid campus id' }]);
  }

  const [report, campus] = await Promise.all([
    entitlement.service.describeForCampus(id, { layer: OVERRIDE_LAYERS.ADMIN }),
    require('../../campus').service.getCampusEntitlementWithAudit(id),
  ]);
  if (!report.found) return sendNotFound(res, 'Campus');

  return sendSuccess(res, 200, 'OK', {
    ...report,
    plans: Object.values(FEATURE_PLANS),
    planPresets: PLAN_PRESETS,
    // The AI values the dialog edits, resolved by the module that owns them —
    // never re-derived here. Phase 4 folds the standalone AI console into this
    // screen, so the tier change and the budget it implies are decided in one
    // place instead of two that each know half the consequence.
    ai: resolveAiEntitlement(campus),
    // Same reason as on the manager's route: the dialog reads its own
    // constraints from the server instead of mirroring literals that would
    // drift the day one of them changes.
    requirements: PILOT_REQUIREMENTS,
    audit: (campus?.entitlementAudit || []).slice(-20).reverse(),
  });
});

/**
 * PATCH /api/admin/campuses/:id/entitlement
 * Body: `{ plan?, modules?: [{ key, state, until?, reason }] }`.
 *
 * The offer layer may raise as well as lower — that is how a module outside the
 * plan is granted (an upsell, a pilot, a grandfathered campus). It is still
 * refused when the change would make records disappear or break a collection
 * that structurally needs the module on this campus, and that check runs on the
 * EFFECTIVE result, so a plan downgrade is scrutinised exactly like a toggle.
 *
 * @access ADMIN | DIRECTOR
 */
const updateCampusEntitlement = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return sendValidationError(res, [{ field: 'id', message: 'Invalid campus id' }]);
  }

  return applyAndRespond(req, res, {
    campusId: id,
    layer: OVERRIDE_LAYERS.ADMIN,
    allowPlan: true,
  });
});

/**
 * GET /api/admin/entitlement/overview
 * The estate matrix (§13.1): every campus, its tier, and the effective state of
 * every module. One row per tenant — the screen an admin opens to answer "who
 * has what, and since when".
 *
 * Read-only and deliberately state-only: editing one campus goes through the
 * per-campus route above, which is the one that carries the refusal checks.
 *
 * @access ADMIN | DIRECTOR
 */
const getEntitlementOverview = asyncHandler(async (req, res) => {
  const estate = await entitlement.service.describeEstate();

  return sendSuccess(res, 200, 'OK', {
    ...estate,
    plans: Object.values(FEATURE_PLANS),
    planPresets: PLAN_PRESETS,
  });
});

module.exports = { getCampusEntitlement, updateCampusEntitlement, getEntitlementOverview };
