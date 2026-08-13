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

module.exports = {
  routes,
  service,
  constants,
  /** Exposed so per-module controllers map service errors identically. */
  respondToError: controller.respondToError,
};
