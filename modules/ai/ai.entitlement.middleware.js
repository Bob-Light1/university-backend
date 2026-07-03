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
 * On success sets:
 *  - req.aiEntitlement : { enabled, plan, llmProfile, monthlyTokenBudget, features }
 *  - req.aiCampusId    : effective campus scope ('' for global roles without one)
 */

const { sendError, asyncHandler } = require('../../shared/utils/response-helpers');
const { buildCampusFilter, isValidObjectId } = require('../../shared/utils/validation-helpers');
const { AI_ERROR_CODES, AI_PLANS } = require('../../shared/constants/ai.constants');
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
  features: Object.freeze({ chat: true, search: true, analytics: true, advisors: true }),
});

/**
 * Resolves the campus whose entitlement applies to this request.
 * Scoped roles: always their own campus (buildCampusFilter throws when the
 * JWT carries none — never trust the body, §4.1). Global roles: an optional
 * ?campusId= narrows to a tenant context; without it the platform context applies.
 * @returns {string|null} campusId, or null for the platform context.
 */
const resolveEntitlementCampus = (req) => {
  if (GLOBAL_ROLES.includes(req.user.role)) {
    const requested = req.query.campusId;
    return requested && isValidObjectId(String(requested)) ? String(requested) : null;
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

    // Platform context (global role, no campus targeted).
    if (campusId === null) {
      req.aiEntitlement = PLATFORM_ENTITLEMENT;
      req.aiCampusId = '';
      return next();
    }

    // 2. Campus subscription. Lazy require: campus is a module hub (see its facade note).
    const campus = await require('../campus').service.getCampusAiEntitlement(campusId);
    const entitlement = campus?.aiEntitlement;
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
