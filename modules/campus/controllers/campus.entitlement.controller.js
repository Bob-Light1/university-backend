'use strict';

/**
 * @file campus.entitlement.controller.js
 * @description The USAGE layer of the per-campus entitlement
 * (CAMPUS_ENTITLEMENT_DESIGN.md §5) — what the campus chooses to switch on
 * INSIDE the offer the platform sold it.
 *
 *   GET   /api/campus/:id/entitlement → the offer and what is active in it
 *   PATCH /api/campus/:id/entitlement → module overrides, bounded by the offer
 *
 * Two layers rather than one because a single layer forces a choice between two
 * bad options: "the manager can grant themselves paid modules", or "the manager
 * can pilot nothing". Here they restrict freely and widen never — and, decision
 * D-E, they switch back on without asking the ADMIN: they can never exceed what
 * their plan allows anyway, so an approval loop would add no guarantee and make
 * the ADMIN a bottleneck on an operation with no stake.
 */

const {
  sendSuccess,
  sendForbidden,
  sendNotFound,
  sendValidationError,
  asyncHandler,
} = require('../../../shared/utils/response-helpers');
const { isValidObjectId, canAccessCampus } = require('../../../shared/utils/validation-helpers');
const { OVERRIDE_LAYERS } = require('../../../shared/utils/entitlement');
const entitlement = require('../../../shared/lib/entitlement');
const {
  applyAndRespond,
  MIN_REASON_LENGTH,
  MAX_REASON_LENGTH,
} = require('../../../shared/lib/entitlement/entitlement.controller');

/**
 * Campus isolation for both routes: a CAMPUS_MANAGER may only ever reach their
 * own campus (CLAUDE.md §2) — the id in the URL is checked against the JWT, and
 * never trusted on its own. ADMIN / DIRECTOR reach any campus.
 *
 * @returns {string|null} the validated campus id, or null once a response has
 *   already been sent.
 */
const resolveTargetCampus = (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    sendValidationError(res, [{ field: 'id', message: 'Invalid campus id' }]);
    return null;
  }
  if (!canAccessCampus(req.user, id)) {
    sendForbidden(res, 'You can only manage the entitlement of your own campus');
    return null;
  }
  return id;
};

/**
 * GET /api/campus/:id/entitlement
 * The manager's own screen: every module of their offer, its effective state,
 * and the override they put on it if any.
 *
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER (own campus)
 */
const getEntitlement = asyncHandler(async (req, res) => {
  const campusId = resolveTargetCampus(req, res);
  if (!campusId) return undefined;

  const report = await entitlement.service.describeForCampus(campusId);
  if (!report.found) return sendNotFound(res, 'Campus');

  return sendSuccess(res, 200, 'OK', {
    ...report,
    // Travel with the payload rather than being mirrored as frontend literals,
    // the way the hard-delete dialog reads its own requirements from the server.
    requirements: { minReasonLength: MIN_REASON_LENGTH, maxReasonLength: MAX_REASON_LENGTH },
  });
});

/**
 * PATCH /api/campus/:id/entitlement
 * Body: `{ modules: [{ key, state, until?, reason }] }`.
 *
 * `plan` is refused here, not ignored: a manager who believes they changed
 * their plan and receives a 200 has been told something false about their bill.
 *
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER (own campus)
 */
const updateEntitlement = asyncHandler(async (req, res) => {
  const campusId = resolveTargetCampus(req, res);
  if (!campusId) return undefined;

  return applyAndRespond(req, res, {
    campusId,
    layer: OVERRIDE_LAYERS.CAMPUS,
    allowPlan: false,
  });
});

module.exports = { getEntitlement, updateEntitlement };
