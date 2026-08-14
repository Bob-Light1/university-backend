'use strict';

/**
 * @file index.js — public surface of the harmonized hard-delete system.
 *
 * Two consumers:
 *  - `app.js` mounts `routes` at `/api/danger-zone`.
 *  - Per-module controllers call `service.execute()` / `service.preview()` so their legacy
 *    `/:id/permanent` routes clear exactly the same controls (CLAUDE.md §5.2).
 *
 * The registry, the guard and the audit model stay internal: an entity becomes hard-deletable
 * by being declared in hard-delete.registry.js, never by a module reaching around it.
 */

const routes    = require('./hard-delete.routes');
const service   = require('./hard-delete.service');
const constants = require('./hard-delete.constants');
const controller = require('./hard-delete.controller');
const { deletionLimiter, hardDeleteFlagLimiter } = require('./hard-delete.limiter');

module.exports = {
  routes,
  service,
  constants,
  /** Exposed so per-module controllers map service errors identically. */
  respondToError: controller.respondToError,
  /**
   * The deletion rate limit, exposed so the compatibility aliases carry the SAME budget as the
   * danger-zone router. They reach the same `execute()` and the same password control; a
   * limiter mounted on one of the two is a limiter that changing URL bypasses.
   *
   * `deletionLimiter` for the dedicated `/permanent` routes, `hardDeleteFlagLimiter` for the
   * routes that only become a permanent deletion under `?hard=true`.
   */
  deletionLimiter,
  hardDeleteFlagLimiter,
};
