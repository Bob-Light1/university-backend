'use strict';

/**
 * @file entitlement.controller.js
 * @description HTTP shape shared by the two pilot routes — the ADMIN offer
 * (`PATCH /api/admin/campuses/:id/entitlement`) and the CAMPUS_MANAGER usage
 * (`PATCH /api/campus/:id/entitlement`).
 *
 * The two differ by exactly one thing: which layer they write. Everything else
 * — payload validation, the mandatory justification, the refusal mapping, the
 * response shape — is identical, so it lives here once (CLAUDE.md §0.1). Two
 * copies would drift, and the half that drifts is always the one with the
 * looser check.
 *
 * Which campus each route may target stays with the route: the admin reaches
 * any campus, the manager only their own (CLAUDE.md §2).
 */

const {
  sendSuccess,
  sendError,
  sendNotFound,
  sendValidationError,
} = require('../../utils/response-helpers');
const {
  FEATURE_STATES,
  FEATURE_KEYS,
  MAX_UNTIL_MONTHS,
} = require('../../constants/features.constants');
const service = require('./entitlement.service');

/**
 * Shortest acceptable justification. A disabled module is what a support
 * ticket opens with ("the button disappeared"); "test" as a reason answers
 * nobody three months later.
 */
const MIN_REASON_LENGTH = 10;
const MAX_REASON_LENGTH = 300;
const MAX_MODULES_PER_CALL = FEATURE_KEYS.length;

/**
 * The constraints a pilot screen must respect, served BY the two GET routes
 * rather than mirrored as frontend literals — the same shape the hard-delete
 * dialog reads its own `requirements` from. One object for both layers, so the
 * admin dialog and the manager tab cannot disagree about the minimum length of
 * a justification.
 */
const PILOT_REQUIREMENTS = Object.freeze({
  minReasonLength: MIN_REASON_LENGTH,
  maxReasonLength: MAX_REASON_LENGTH,
  maxUntilMonths: MAX_UNTIL_MONTHS,
});

/**
 * The two parts of an entitlement that carry VALUES rather than module states.
 * Both belong to the OFFER: a quota and an LLM profile are what was sold, so a
 * manager setting their own would be a manager writing their own bill.
 */
const VALUE_FIELDS = Object.freeze(['quotas', 'ai']);

/**
 * Validates the PATCH body.
 *
 * @param {Object} body
 * @param {boolean} allowPlan - true for the offer layer only. Also gates the
 *   value fields, which follow the same layer rule as the tier.
 * @returns {{errors: Array, plan: string|undefined, modules: Array, values: Object}}
 */
const parsePayload = (body = {}, allowPlan = false) => {
  const errors = [];
  const modules = [];
  const values = {};
  let plan;

  if (body.plan !== undefined) {
    if (!allowPlan) {
      // Refused rather than ignored: a manager who believes they changed the
      // plan and got a 200 has been told something false about their own bill.
      errors.push({ field: 'plan', message: 'Only the platform administration can change the plan' });
    } else {
      plan = body.plan;
    }
  }

  if (body.modules !== undefined) {
    if (!Array.isArray(body.modules)) {
      errors.push({ field: 'modules', message: 'modules must be an array' });
    } else if (body.modules.length > MAX_MODULES_PER_CALL) {
      errors.push({ field: 'modules', message: `modules cannot exceed ${MAX_MODULES_PER_CALL} entries` });
    } else {
      body.modules.forEach((entry, index) => {
        const at = `modules[${index}]`;
        if (!entry || typeof entry !== 'object') {
          errors.push({ field: at, message: 'each entry must be an object' });
          return;
        }
        if (!FEATURE_KEYS.includes(entry.key)) {
          errors.push({ field: `${at}.key`, message: `unknown feature '${entry.key}'` });
          return;
        }
        if (!Object.values(FEATURE_STATES).includes(entry.state)) {
          errors.push({
            field: `${at}.state`,
            message: `state must be one of: ${Object.values(FEATURE_STATES).join(', ')}`,
          });
          return;
        }

        const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
        // Mandatory on any restriction, on BOTH layers. Enabling something back
        // needs no justification; taking it away always does — that reason is
        // what the manager is shown and what the audit row carries (§12).
        if (entry.state !== FEATURE_STATES.ENABLED && reason.length < MIN_REASON_LENGTH) {
          errors.push({
            field: `${at}.reason`,
            message: `a reason of at least ${MIN_REASON_LENGTH} characters is required to restrict a module`,
          });
          return;
        }
        if (reason.length > MAX_REASON_LENGTH) {
          errors.push({ field: `${at}.reason`, message: `reason must not exceed ${MAX_REASON_LENGTH} characters` });
          return;
        }

        modules.push({ key: entry.key, state: entry.state, until: entry.until ?? null, reason });
      });
    }
  }

  // Shape only, deliberately — what a quota or an LLM profile MEANS belongs to
  // whoever owns the vocabulary: the schema enforces the ranges and the enums
  // as the last line of defence (CLAUDE.md §6), and the service refuses a
  // non-object outright. Growing a branch per field here is how a generic door
  // ends up knowing about the AI.
  for (const field of VALUE_FIELDS) {
    if (body[field] === undefined) continue;
    if (!allowPlan) {
      // Refused rather than ignored, for the same reason as `plan` above.
      errors.push({ field, message: `Only the platform administration can change ${field}` });
      continue;
    }
    if (typeof body[field] !== 'object' || body[field] === null || Array.isArray(body[field])) {
      errors.push({ field, message: `${field} must be an object` });
      continue;
    }
    values[field] = body[field];
  }

  if (plan === undefined && modules.length === 0
      && !Object.keys(values).length && !errors.length) {
    errors.push({ field: 'body', message: 'No entitlement change submitted' });
  }

  return { errors, plan, modules, values };
};

/**
 * Maps a refused change to its HTTP answer.
 *
 * The worst status among the blockers wins, and the FULL list travels — never
 * one at a time, the way the hard-delete impact report does it. An operator who
 * discovers a refusal item by item is an operator who will work around it.
 *
 * Extracted so the AI console (`admin.ai-entitlement.controller.js`), which
 * reaches the same door with a different payload since phase 2, refuses in
 * exactly the same words as the entitlement routes.
 *
 * @param {Object} res
 * @param {Object} result - A non-ok `applyChanges()` result.
 * @returns {Object} the Express response.
 */
const sendRefusal = (res, result) => {
  const status = result.blockers.reduce((worst, b) => Math.max(worst, b.status), 400);
  const primary = result.blockers.find((b) => b.status === status) || result.blockers[0];
  return sendError(res, status, primary.message, {
    code: primary.code,
    blockers: result.blockers.map(({ status: _status, ...rest }) => rest),
    warnings: result.warnings || [],
  });
};

/**
 * Runs one layer's change and maps the outcome to HTTP.
 *
 * Refusals answer with the status the guard chose, the dedicated code and the
 * FULL list of blockers — never one at a time. An operator who has to discover
 * a refusal item by item is an operator who will find a way around it.
 *
 * @param {Object} req
 * @param {Object} res
 * @param {Object} params
 * @param {string} params.campusId
 * @param {string} params.layer - `OVERRIDE_LAYERS.ADMIN` | `.CAMPUS`.
 * @param {boolean} params.allowPlan
 * @returns {Promise<Object>} the Express response.
 */
const applyAndRespond = async (req, res, { campusId, layer, allowPlan }) => {
  const { errors, plan, modules, values } = parsePayload(req.body, allowPlan);
  if (errors.length) return sendValidationError(res, errors);

  const result = await service.applyChanges({
    campusId,
    layer,
    actor: req.user,
    ...(plan !== undefined ? { plan } : {}),
    ...values,
    modules,
  });

  if (result.notFound) return sendNotFound(res, 'Campus');
  if (!result.ok) return sendRefusal(res, result);

  return sendSuccess(res, 200, 'Entitlement updated', {
    campusId: String(campusId),
    plan: result.resolved.plan,
    features: result.resolved.features,
    quotas: result.resolved.quotas,
    // Soft edges that will degrade — shown, never enforced (§6.3.1).
    warnings: result.warnings || [],
  });
};

module.exports = {
  MIN_REASON_LENGTH,
  MAX_REASON_LENGTH,
  PILOT_REQUIREMENTS,
  parsePayload,
  sendRefusal,
  applyAndRespond,
};
