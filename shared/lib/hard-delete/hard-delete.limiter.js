'use strict';

/**
 * @file hard-delete.limiter.js
 * @description The single rate limiter guarding permanent deletion, platform-wide.
 *
 * It lives in its own file rather than inside `hard-delete.routes.js` because the danger-zone
 * router is NOT the only way to reach `service.execute()`. Every per-module compatibility
 * alias reaches the same code path and clears the same password control:
 *
 *   DELETE /api/students/:id/permanent      DELETE /api/mentors/:id/permanent
 *   DELETE /api/teachers/:id/permanent      DELETE /api/staff-roles/:id
 *   DELETE /api/staff/:id/permanent         DELETE /api/parents/:id?hard=true
 *                                           DELETE /api/documents/:id?hard=true
 *
 * A budget enforced on the danger-zone router alone is a budget an attacker skips by changing
 * URL — the alias would offer unmetered attempts against the operator's password. One limiter,
 * one shared store prefix, mounted on all of them.
 *
 * Ten attempts per hour per IP still throttles the password control hard: reaching it already
 * requires a valid signed ticket and the exact confirmation phrase, neither of which can be
 * brute-forced.
 */

const { createCustomLimiter } = require('../../middleware/rate-limiter');
const { DELETION_RATE_LIMIT } = require('./hard-delete.constants');

/** @type {import('express').RequestHandler} */
const deletionLimiter = createCustomLimiter(
  DELETION_RATE_LIMIT.WINDOW_MINUTES,
  DELETION_RATE_LIMIT.MAX_ATTEMPTS,
  DELETION_RATE_LIMIT.MESSAGE,
  { prefix: DELETION_RATE_LIMIT.STORE_PREFIX },
);

/**
 * Same limiter, applied only when the request actually asks for a permanent deletion.
 *
 * `DELETE /api/parents/:id` and `DELETE /api/documents/:id` serve both operations, switching on
 * `?hard=true`. Metering the archive path with the deletion budget would let ordinary archiving
 * exhaust it — and, worse, make the danger zone unavailable for the rest of the hour because
 * someone archived eleven rows.
 *
 * @type {import('express').RequestHandler}
 */
const hardDeleteFlagLimiter = (req, res, next) =>
  (req.query.hard === 'true' ? deletionLimiter(req, res, next) : next());

module.exports = {
  deletionLimiter,
  hardDeleteFlagLimiter,
};
