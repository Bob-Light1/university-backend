'use strict';

/**
 * @file index.js — public surface of the per-campus entitlement system.
 *
 * Design doc: `docs/architecture/CAMPUS_ENTITLEMENT_DESIGN.md`.
 *
 * Consumers:
 *  - `app.js`                     → `mountEntitlementGates(app)`;
 *  - the admin / campus PATCH routes → `service.applyChanges()`;
 *  - `GET /api/settings/entitlement` → `service.describeForCampus()`;
 *  - the crons (phase 5)          → `service.resolveForCampus()`.
 *
 * The registry, the guard, the probes and the cache stay internal: a module
 * becomes governed by being declared in `shared/constants/features.constants.js`,
 * never by a controller reaching around this door.
 */

const service = require('./entitlement.service');
const cache   = require('./entitlement.cache');
const guard   = require('./entitlement.guard');
const { requireFeature, mountEntitlementGates } = require('../../middleware/entitlement');

module.exports = {
  service,
  guard,
  /** Exposed so tests and graceful shutdown can drop the in-process entries. */
  cache,
  requireFeature,
  mountEntitlementGates,
};
