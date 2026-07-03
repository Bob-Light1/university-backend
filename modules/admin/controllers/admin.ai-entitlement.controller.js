'use strict';

/**
 * @file admin.ai-entitlement.controller.js
 * @description Platform administration of the per-campus AI entitlement
 * (PHASE3_AI_DESIGN.md §11.3). ADMIN / DIRECTOR only. The `plan` stored here
 * is the pivot a future billing module will consume — single source of truth.
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

const PLAN_VALUES = Object.values(AI_PLANS);
const FEATURE_KEYS = Object.values(AI_FEATURES);

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

  return sendSuccess(res, 200, 'OK', {
    campusId: id,
    campusName: campus.campus_name,
    aiEntitlement: campus.aiEntitlement,
    audit: (campus.aiEntitlementAudit || []).slice(-20).reverse(),
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

  const current = campus.aiEntitlement || {};
  const planChanged = updates.plan !== undefined && updates.plan !== current.plan;
  const preset = planChanged ? AI_PLAN_PRESETS[updates.plan] : null;

  const next = {
    enabled: updates.enabled ?? current.enabled ?? false,
    plan: updates.plan ?? current.plan ?? AI_PLANS.FREE,
    llmProfile: updates.llmProfile ?? current.llmProfile ?? 'free',
    // Plan switch without explicit override → D10 preset of the new plan.
    monthlyTokenBudget:
      updates.monthlyTokenBudget ??
      (preset ? preset.monthlyTokenBudget : current.monthlyTokenBudget ?? AI_PLAN_PRESETS[AI_PLANS.FREE].monthlyTokenBudget),
    features:
      updates.features ??
      (preset ? { ...preset.features } : { chat: true, search: true, analytics: false, advisors: false, ...current.features }),
    activatedAt: current.activatedAt ?? null,
  };
  if (next.enabled && !current.enabled) {
    next.activatedAt = new Date();
  }

  const updated = await campusService.setCampusAiEntitlement(id, next, {
    actorId: req.user.id,
    actorRole: req.user.role,
    changes: updates,
  });

  return sendSuccess(res, 200, 'AI entitlement updated', {
    campusId: id,
    campusName: updated.campus_name,
    aiEntitlement: updated.aiEntitlement,
  });
});

module.exports = {
  getCampusAiEntitlement,
  updateCampusAiEntitlement,
};
