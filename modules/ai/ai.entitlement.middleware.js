'use strict';

/**
 * @file ai.entitlement.middleware.js
 * @description Per-campus AI entitlement gate (§11.3) — Node stage of the
 * defense in depth (ai-service re-checks plan/budget from the S2S JWT).
 *
 * Chain (after authenticate): global kill-switch → campus entitlement →
 * feature-in-plan → monthly token budget. Distinct statuses on purpose:
 * 503 "AI disabled" (not deployed) ≠ 403 "not subscribed" ≠ 429 "budget spent".
 *
 * Since phase 2 of `CAMPUS_ENTITLEMENT_DESIGN.md` the four rungs of that ladder
 * read the UNIFIED per-campus entitlement instead of the AI's own object: the
 * subscription is the state of the `ai` key, the tier is the campus tier, the
 * budget is `quotas.aiMonthlyTokens`. What is genuinely AI-specific — the
 * sub-features, the token budget, the LLM profile — stays owned by the AI.
 * `shared/lib/entitlement/entitlement.ai.js` is where the two meet, and where
 * the transitional fallback to the legacy object lives (§3.2).
 *
 * The generic gate mounted on `/api/ai` (§7.1) already refuses the whole module
 * when the campus hides it and refuses every mutation when it is frozen. This
 * one is NOT a duplicate of it: it runs per AI sub-feature, it resolves the
 * campus a global role is acting ON (`?campusId=`, which the generic gate
 * deliberately does not narrow, §5.2), and it owns the token budget.
 *
 * On success sets:
 *  - req.aiEntitlement : { enabled, plan, llmProfile, monthlyTokenBudget, features }
 *  - req.aiCampusId    : effective campus scope ('' for global roles without one)
 */

const { sendError, sendValidationError, asyncHandler } = require('../../shared/utils/response-helpers');
const { buildCampusFilter, isValidObjectId } = require('../../shared/utils/validation-helpers');
const { AI_ERROR_CODES, AI_PLANS, AI_PLAN_PRESETS } = require('../../shared/constants/ai.constants');
const { resolveAiEntitlement } = require('../../shared/lib/entitlement/entitlement.ai');
const { GLOBAL_ROLES } = require('./ai.s2s');
const aiService = require('./ai.service');

/**
 * Platform context for ADMIN / DIRECTOR acting outside any campus: all
 * features, unlimited budget, but the SAFE zero-cost LLM profile — a paid
 * profile is always a per-campus entitlement decision, never a role side
 * effect (ADR-5).
 */
const PLATFORM_ENTITLEMENT = Object.freeze({
  enabled: true,
  plan: AI_PLANS.PREMIUM,
  llmProfile: 'free',
  monthlyTokenBudget: 0,
  // Derived, not restated: a fifth AI feature must reach the platform context
  // by being added to the top tier, never by someone remembering this line.
  features: AI_PLAN_PRESETS[AI_PLANS.PREMIUM].features,
});

/** Marker for a malformed ?campusId= — a 400, never a silent scope widening. */
const INVALID_CAMPUS = Symbol('invalidCampusId');

/**
 * Resolves the campus whose entitlement applies to this request.
 * Scoped roles: always their own campus (buildCampusFilter throws when the
 * JWT carries none — never trust the body, §4.1). Global roles: an optional
 * ?campusId= narrows to a tenant context; without it the platform context applies.
 *
 * A malformed ?campusId= is rejected rather than ignored: falling back to the
 * platform context would silently answer a campus-scoped question with a
 * platform-scoped (and cheaper, zero-cost profile) context.
 *
 * @returns {string|null|Symbol} campusId, null for the platform context, or
 *   INVALID_CAMPUS when a global role sent a malformed campusId.
 */
const resolveEntitlementCampus = (req) => {
  if (GLOBAL_ROLES.includes(req.user.role)) {
    const requested = req.query.campusId;
    if (requested === undefined || requested === null || requested === '') return null;
    return isValidObjectId(String(requested)) ? String(requested) : INVALID_CAMPUS;
  }
  buildCampusFilter(req.user); // throws when a scoped role has no valid campusId
  return String(req.user.campusId);
};

/**
 * Builds the entitlement gate for one AI feature.
 * @param {string|null} feature - 'chat' | 'search' | 'analytics' | 'advisors',
 *   or null to only require the AI to be enabled (e.g. GET /usage).
 * @returns {Function} Express middleware.
 */
const requireAiFeature = (feature) =>
  asyncHandler(async (req, res, next) => {
    // 1. Global kill-switch (§11.1) — no config, no external call, ever.
    if (!aiService.isEnabled()) {
      return sendError(res, 503, 'AI features are disabled on this deployment', {
        code: AI_ERROR_CODES.AI_DISABLED,
      });
    }

    let campusId;
    try {
      campusId = resolveEntitlementCampus(req);
    } catch {
      return sendError(res, 403, 'No campus is bound to your account', {
        code: AI_ERROR_CODES.AI_NOT_ENABLED,
      });
    }

    if (campusId === INVALID_CAMPUS) {
      return sendValidationError(res, [{ field: 'campusId', message: 'campusId must be a valid ObjectId' }]);
    }

    // Platform context (global role, no campus targeted).
    if (campusId === null) {
      req.aiEntitlement = PLATFORM_ENTITLEMENT;
      req.aiCampusId = '';
      return next();
    }

    // 2. Campus subscription — read from the UNIFIED entitlement since phase 2,
    // with the legacy object answering for a campus the migration has not
    // reached yet (§3.2). `resolveAiEntitlement` owns which side answers, so
    // this file never asks the question twice.
    //
    // The campus is read directly rather than through the entitlement cache:
    // the cache holds a resolved entitlement and nothing else, while this gate
    // additionally needs `status` (a suspended tenant must stop spending) and,
    // until §3.2 lands, the legacy object. One read, both facts. The AI surface
    // is a handful of routes, not the 26 the cached gate fronts (§7.2).
    //
    // Lazy require: campus is a module hub (see its facade note).
    const campus = await require('../campus').service.getCampusAiEntitlement(campusId);
    const entitlement = campus ? resolveAiEntitlement(campus) : null;
    if (!campus || campus.status !== 'active' || !entitlement?.enabled) {
      return sendError(res, 403, 'AI is not enabled for this campus', {
        code: AI_ERROR_CODES.AI_NOT_ENABLED,
      });
    }

    // 3. Feature-in-plan.
    if (feature && !entitlement.features?.[feature]) {
      return sendError(res, 403, `The '${feature}' AI feature is not included in this campus plan`, {
        code: AI_ERROR_CODES.AI_FEATURE_NOT_IN_PLAN,
      });
    }

    // 4. Monthly token budget (0 = unlimited). Usage lives in ai-service
    // (usage_monthly); when it cannot be read, Node fails open — ai-service
    // re-verifies the budget before every LLM call (§11.3 stage 2).
    if (entitlement.monthlyTokenBudget > 0) {
      const usage = await aiService.fetchMonthlyUsage(req.user, entitlement, campusId);
      const consumed = usage ? (usage.tokensIn || 0) + (usage.tokensOut || 0) : 0;
      if (usage && consumed >= entitlement.monthlyTokenBudget) {
        return sendError(res, 429, 'The monthly AI token budget of this campus is exhausted', {
          code: AI_ERROR_CODES.AI_BUDGET_EXCEEDED,
        });
      }
    }

    req.aiEntitlement = entitlement;
    req.aiCampusId = campusId;
    return next();
  });

module.exports = { requireAiFeature, PLATFORM_ENTITLEMENT };
