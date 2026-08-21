'use strict';

/**
 * @file portal-campus.js
 * @description Campus resolution for the PUBLIC portal surface, entitlement
 * included — §9.2 of `docs/architecture/CAMPUS_ENTITLEMENT_DESIGN.md`.
 *
 * `/api/public/*` is the one gated surface with no JWT: the requests come from
 * the Next.js portal on behalf of an anonymous visitor, so the campus is
 * resolved from a slug or a partner code, never from `req.user`. The app-level
 * gate (`shared/middleware/entitlement.js`) sees no identity here and lets the
 * request through by design — which is why the check has to happen where the
 * campus actually becomes known: right after it is looked up.
 *
 * ── A HIDDEN PORTAL IS AN ABSENT PORTAL ─────────────────────────────────────
 * `hidden` answers 404, the same answer as a campus that does not exist or has
 * been archived. That is §4.1.2 taken literally: to a visitor on the public
 * web, a module that is not enabled must be indistinguishable from one that was
 * never built. A 403 saying "this campus has not subscribed to the portal"
 * would publish a tenant's commercial standing to anyone with a URL.
 *
 * The three cases share ONE code path rather than agreeing by convention —
 * which is also why this helper owns the not-found answer instead of leaving it
 * in each of the ten controllers.
 *
 * ── `read_only` STOPS THE INTAKE, NOT THE SITE ──────────────────────────────
 * A frozen portal keeps serving programs, FAQ, testimonials and the
 * leaderboard, and refuses the five submissions (pre-registration, quiz answer,
 * contact, partner application, next-batch alert) with the same
 * `FEATURE_READ_ONLY` code the authenticated surface uses. A campus pausing its
 * recruitment while keeping its page online is the case the state exists for;
 * answering 404 there would take the whole site down instead.
 */

const { FEATURE_ERROR_CODES, FEATURE_STATES } = require('../../shared/constants/features.constants');
const { getFeatureState } = require('../../shared/utils/entitlement');
const { sendError, sendNotFound } = require('../../shared/utils/response-helpers');

/** Lazy facade access — campus is a module hub (see `campus.service.js`). */
const campusSvc = () => require('../campus').service;
/** Lazy: the entitlement service reaches that same hub. */
const entitlementSvc = () => require('../../shared/lib/entitlement').service;

/** The registry key governing this whole surface. */
const PORTAL_FEATURE = 'public-portal';

/**
 * The five public routes that WRITE. Declared so
 * `tests/unit/entitlement.jobs.test.js` can compare them to the non-GET routes
 * actually mounted in `public.routes.js`: a new submission endpoint added
 * without passing `{ write: true }` would otherwise keep taking leads for a
 * campus that froze its intake, and nothing would say so.
 */
const PORTAL_WRITE_ROUTES = Object.freeze([
  '/pre-register',
  '/quiz/submit',
  '/contact',
  '/partner-application',
  '/alert',
]);

/**
 * Effective portal state for one campus, fail-open on any lookup failure (§4.3).
 *
 * @param {string|import('mongoose').Types.ObjectId} campusId
 * @returns {Promise<string>} one of FEATURE_STATES
 */
const portalState = async (campusId) => {
  try {
    const resolved = await entitlementSvc().resolveForCampus(String(campusId));
    return getFeatureState(resolved, PORTAL_FEATURE);
  } catch {
    return FEATURE_STATES.ENABLED;
  }
};

/**
 * Resolves the campus of a public request and applies the portal entitlement.
 *
 * Follows the house `getCampusFilter(req, res)` shape (CLAUDE.md §2): on a
 * refusal it ANSWERS and returns null, so the caller's whole error handling is
 * `if (!campus) return;`.
 *
 * @param {import('express').Response} res
 * @param {Object} params
 * @param {string} [params.slug]   - `campusSlug`, already trimmed by the caller.
 * @param {*}      [params.id]     - Campus id, for the `?ref=PARTNER_CODE` path.
 * @param {string} [params.select='_id'] - Mongoose projection.
 * @param {boolean}[params.write=false]  - true for a submission endpoint.
 * @returns {Promise<Object|null>} the lean campus, or null once answered.
 */
const resolvePortalCampus = async (res, { slug, id, select = '_id', write = false }) => {
  const campus = slug
    ? await campusSvc().getActiveCampusBySlug(slug, select)
    : (id ? await campusSvc().getActiveCampusById(id, select) : null);

  if (!campus) {
    sendNotFound(res, 'Campus');
    return null;
  }

  const state = await portalState(campus._id);

  if (state === FEATURE_STATES.HIDDEN) {
    // Same answer as "no such campus" — deliberately (see the file header).
    sendNotFound(res, 'Campus');
    return null;
  }

  if (write && state === FEATURE_STATES.READ_ONLY) {
    sendError(res, 403, 'This campus is not accepting submissions at the moment.', {
      code:    FEATURE_ERROR_CODES.FEATURE_READ_ONLY,
      feature: PORTAL_FEATURE,
    });
    return null;
  }

  return campus;
};

/**
 * Drops the campuses whose portal is not published from a public listing.
 *
 * The selection page is the one place a campus appears without having been
 * asked for by name; leaving a hidden one in it would advertise a page that
 * then answers 404 — the dead link the entitlement system exists to avoid
 * (§4.1.2). Frozen campuses stay listed: their site is up, only the intake is
 * closed.
 *
 * @param {Array} campuses - Lean campuses carrying `_id`.
 * @returns {Promise<Array>}
 */
const filterPortalCampuses = async (campuses) => {
  const states = await Promise.all(campuses.map((campus) => portalState(campus._id)));
  return campuses.filter((_, index) => states[index] !== FEATURE_STATES.HIDDEN);
};

module.exports = {
  PORTAL_FEATURE,
  PORTAL_WRITE_ROUTES,
  portalState,
  resolvePortalCampus,
  filterPortalCampuses,
};
