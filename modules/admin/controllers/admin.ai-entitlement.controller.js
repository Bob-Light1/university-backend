'use strict';

/**
 * @file admin.ai-entitlement.controller.js
 * @description Platform administration of the per-campus AI entitlement
 * (PHASE3_AI_DESIGN.md §11.3). ADMIN / DIRECTOR only.
 *
 * ── PHASE 2 — THE ROUTE IS UNCHANGED, ITS STORAGE IS NOT ────────────────────
 * The wire contract is frozen (`{ enabled, plan, llmProfile, monthlyTokenBudget,
 * features }` in and out, plus the audit trail): the AI console and its dialog
 * keep working untouched, which is the acceptance criterion of the phase. What
 * changed is underneath — the payload is now translated into the UNIFIED
 * entitlement and written through `entitlementService.applyChanges()`, the one
 * door (CAMPUS_ENTITLEMENT_DESIGN.md §10 phase 2):
 *
 *   enabled            → the `ai` module override (enabled | hidden)
 *   plan               → entitlement.plan
 *   monthlyTokenBudget → entitlement.quotas.aiMonthlyTokens
 *   llmProfile         → entitlement.ai.llmProfile
 *   features           → entitlement.ai.features, DEVIATIONS from the preset only
 *
 * Going through that door rather than writing the object directly is what buys
 * the audit row, the cache invalidation and the transition guard for free — a
 * plan downgrade made from this screen is checked for records exactly like one
 * made from the entitlement screen, because it is the same call.
 *
 * ⚠️ `plan` IS THE PLATFORM TIER (decision D-D: one commercial grid, never two).
 * Moving a campus to `premium` from here therefore widens its whole offer, not
 * just its AI. That is the intended end state of the unification — phase 4
 * replaces this dialog with the full entitlement matrix, where the consequence
 * is visible on screen instead of implied.
 *
 * Campus data is reached through the campus facade (lazy require — campus is
 * a module hub, see its facade note); no model is touched here.
 */

const {
  sendSuccess,
  sendNotFound,
  sendValidationError,
  asyncHandler,
} = require('../../../shared/utils/response-helpers');
const { isValidObjectId } = require('../../../shared/utils/validation-helpers');
const {
  AI_PLANS,
  AI_FEATURES,
  AI_PLAN_PRESETS,
} = require('../../../shared/constants/ai.constants');
const { FEATURE_STATES } = require('../../../shared/constants/features.constants');
const { OVERRIDE_LAYERS } = require('../../../shared/utils/entitlement');
const entitlementService = require('../../../shared/lib/entitlement/entitlement.service');
const { sendRefusal } = require('../../../shared/lib/entitlement/entitlement.controller');
const {
  AI_FEATURE_KEY,
  resolveAiEntitlement,
  aiFeatureDeviations,
} = require('../../../shared/lib/entitlement/entitlement.ai');

const PLAN_VALUES = Object.values(AI_PLANS);
const FEATURE_KEYS = Object.values(AI_FEATURES);

/**
 * Justification carried on the `ai` override written from this screen. The
 * entitlement guard does not demand one, but the audit row and the manager's
 * screen both display it: an override with no reason is a decision nobody can
 * account for three months later (§12).
 */
const REASON = 'AI entitlement set from the platform AI console';

/**
 * Validates the PUT payload. Returns { errors } or { updates } where updates
 * only contains the explicitly provided, sanitized fields.
 */
const validateEntitlementPayload = (body) => {
  const errors = [];
  const updates = {};

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      errors.push({ field: 'enabled', message: 'enabled must be a boolean' });
    } else {
      updates.enabled = body.enabled;
    }
  }

  if (body.plan !== undefined) {
    if (!PLAN_VALUES.includes(body.plan)) {
      errors.push({ field: 'plan', message: `plan must be one of: ${PLAN_VALUES.join(', ')}` });
    } else {
      updates.plan = body.plan;
    }
  }

  if (body.llmProfile !== undefined) {
    if (typeof body.llmProfile !== 'string' || !body.llmProfile.trim() || body.llmProfile.trim().length > 50) {
      errors.push({ field: 'llmProfile', message: 'llmProfile must be a non-empty string (max 50 chars)' });
    } else {
      updates.llmProfile = body.llmProfile.trim();
    }
  }

  if (body.monthlyTokenBudget !== undefined) {
    const budget = Number(body.monthlyTokenBudget);
    if (!Number.isInteger(budget) || budget < 0) {
      errors.push({ field: 'monthlyTokenBudget', message: 'monthlyTokenBudget must be an integer ≥ 0 (0 = unlimited)' });
    } else {
      updates.monthlyTokenBudget = budget;
    }
  }

  if (body.features !== undefined) {
    if (typeof body.features !== 'object' || body.features === null || Array.isArray(body.features)) {
      errors.push({ field: 'features', message: 'features must be an object' });
    } else {
      const unknown = Object.keys(body.features).filter((k) => !FEATURE_KEYS.includes(k));
      const nonBoolean = Object.entries(body.features).filter(([, v]) => typeof v !== 'boolean');
      if (unknown.length) {
        errors.push({ field: 'features', message: `unknown feature(s): ${unknown.join(', ')}` });
      } else if (nonBoolean.length) {
        errors.push({ field: 'features', message: 'feature flags must be booleans' });
      } else {
        updates.features = body.features;
      }
    }
  }

  return { errors, updates };
};

/**
 * GET /api/admin/campuses/:id/ai-entitlement
 * Current entitlement + last audit entries (admin console).
 */
const getCampusAiEntitlement = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return sendValidationError(res, [{ field: 'id', message: 'Invalid campus id' }]);
  }

  const campus = await require('../../campus').service.getCampusAiEntitlementWithAudit(id);
  if (!campus) return sendNotFound(res, 'Campus');

  // The two ledgers are concatenated, not chosen between: entries written
  // before phase 2 sit in `aiEntitlementAudit` and stay there for good (an
  // append-only trail is never rewritten, CLAUDE.md §8), while everything
  // since lands in `entitlementAudit`. Showing one would silently truncate the
  // history at the migration date — precisely the moment an operator looking
  // at this screen is trying to understand.
  const audit = [...(campus.aiEntitlementAudit || []), ...(campus.entitlementAudit || [])]
    .sort((a, b) => new Date(a.at) - new Date(b.at))
    .slice(-20)
    .reverse();

  return sendSuccess(res, 200, 'OK', {
    campusId: id,
    campusName: campus.campus_name,
    aiEntitlement: resolveAiEntitlement(campus),
    audit,
  });
});

/**
 * PUT /api/admin/campuses/:id/ai-entitlement
 * Activates / updates the AI entitlement of a campus. When the plan changes
 * without explicit budget/features, the D10 preset of the new plan applies.
 * Every mutation appends an audit entry (append-only, CLAUDE.md §8).
 */
const updateCampusAiEntitlement = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return sendValidationError(res, [{ field: 'id', message: 'Invalid campus id' }]);
  }

  const { errors, updates } = validateEntitlementPayload(req.body || {});
  if (errors.length) return sendValidationError(res, errors);
  if (Object.keys(updates).length === 0) {
    return sendValidationError(res, [{ field: 'body', message: 'No entitlement field to update' }]);
  }

  const campusService = require('../../campus').service;
  const campus = await campusService.getCampusAiEntitlement(id);
  if (!campus) return sendNotFound(res, 'Campus');

  // Effective state, whichever object the campus carries — the payload is a
  // partial patch, so it is merged onto what is actually in force today, never
  // onto a default.
  const current = resolveAiEntitlement(campus);
  const planChanged = updates.plan !== undefined && updates.plan !== current.plan;
  const nextPlan = updates.plan ?? current.plan;
  const preset = AI_PLAN_PRESETS[nextPlan] ?? AI_PLAN_PRESETS[AI_PLANS.FREE];

  // Feature flags MERGE onto the base (never wholesale-replace): a partial
  // `{ features: { advisors: true } }` PUT must not silently disable chat and
  // search. Base = the new plan preset on a plan switch, else the current set.
  const nextFeatures = {
    ...(planChanged ? preset.features : current.features),
    ...updates.features,
  };

  // `enabled` is no longer a flag of its own: it IS the state of the `ai`
  // module, so switching the AI off from here and hiding it from the entitlement
  // matrix are the same write, with the same audit row and the same guard.
  const aiModuleChange = updates.enabled === undefined ? [] : [{
    key:    AI_FEATURE_KEY,
    state:  updates.enabled ? FEATURE_STATES.ENABLED : FEATURE_STATES.HIDDEN,
    until:  null,
    reason: REASON,
  }];

  const result = await entitlementService.applyChanges({
    campusId: id,
    layer: OVERRIDE_LAYERS.ADMIN,
    actor: req.user,
    ...(updates.plan !== undefined ? { plan: updates.plan } : {}),
    modules: aiModuleChange,
    quotas: {
      // Plan switch without an explicit budget → D10 preset of the new plan.
      aiMonthlyTokens: updates.monthlyTokenBudget
        ?? (planChanged ? preset.monthlyTokenBudget : current.monthlyTokenBudget),
    },
    ai: {
      llmProfile: updates.llmProfile ?? current.llmProfile,
      // Only the deviations are stored (§3); `null` clears the last one, which
      // is how a campus is handed back to the grid instead of freezing a copy
      // of the tier it happened to be on.
      features: aiFeatureDeviations(nextFeatures, nextPlan),
    },
  });

  if (result.notFound) return sendNotFound(res, 'Campus');
  // The unified door refuses what the AI console alone never could — most
  // notably a tier DOWNGRADE that would bury records of another module (§6.3.4).
  if (!result.ok) return sendRefusal(res, result);

  return sendSuccess(res, 200, 'AI entitlement updated', {
    campusId: id,
    campusName: campus.campus_name,
    aiEntitlement: resolveAiEntitlement({ entitlement: result.entitlement }),
  });
});

module.exports = {
  getCampusAiEntitlement,
  updateCampusAiEntitlement,
};
