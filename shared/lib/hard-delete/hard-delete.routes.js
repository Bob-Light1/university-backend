'use strict';

/**
 * @file hard-delete.routes.js
 * @description Danger-zone router — the harmonized entry point for permanent deletion.
 *
 * Mounted at `/api/danger-zone`. Every route is authenticated, restricted to global roles,
 * and rate-limited: a brute-force attempt against the password control must not be cheap.
 * Per-entity role narrowing happens in the registry, not here.
 */

const express = require('express');

const { authenticate, authorize } = require('../../middleware/auth');
const { apiLimiter, createCustomLimiter } = require('../../middleware/rate-limiter');
const { DANGER_ZONE_ROLES } = require('./hard-delete.constants');
const controller = require('./hard-delete.controller');

/**
 * Dedicated limiter, with its own store prefix on purpose.
 *
 * Reusing `strictLimiter` would share a single 3-per-hour budget with GAET generation, admin
 * creation and partner password resets — an admin who ran two timetable generations would
 * find the danger zone locked, and vice versa. 10 attempts per hour per IP still throttles
 * the password control hard: reaching it already requires a valid signed ticket and the exact
 * confirmation phrase, neither of which can be brute-forced.
 */
const deletionLimiter = createCustomLimiter(
  60,
  10,
  'Too many permanent-deletion attempts. Please try again later.',
  { prefix: 'hard-delete' },
);

const router = express.Router();

router.use(authenticate);
router.use(authorize(DANGER_ZONE_ROLES));

/**
 * @route  GET /api/danger-zone/entities
 * @desc   Entity types the caller may permanently delete, plus the confirmation policy
 * @access ADMIN | DIRECTOR
 */
router.get('/entities', apiLimiter, controller.getDeletableEntities);

/**
 * @route  GET /api/danger-zone/history
 * @desc   Paginated ledger of permanent deletions (completed and refused)
 * @access ADMIN | DIRECTOR
 */
router.get('/history', apiLimiter, controller.getDeletionHistory);

// Named routes are declared before the parameterised ones (CLAUDE.md §7).

/**
 * @route  GET /api/danger-zone/:entityType/:id/impact
 * @desc   Impact report + deletion ticket. Read-only.
 * @access ADMIN | DIRECTOR
 */
router.get('/:entityType/:id/impact', apiLimiter, controller.getDeletionImpact);

/**
 * @route  DELETE /api/danger-zone/:entityType/:id
 * @desc   Permanent deletion. Requires ticket + phrase + password + reason in the body.
 * @access ADMIN | DIRECTOR
 */
router.delete('/:entityType/:id', deletionLimiter, controller.executeHardDelete);

module.exports = router;
