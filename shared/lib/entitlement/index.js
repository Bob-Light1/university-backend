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
 *  - the crons (phase 5)          → `jobs.isEmissionAllowed()` / `.suppressedCampusIds()`;
 *  - `modules/ai`                 → `ai.resolveAiEntitlement()` (phase 2).
 *
 * The registry, the guard, the probes and the cache stay internal: a module
 * becomes governed by being declared in `shared/constants/features.constants.js`,
 * never by a controller reaching around this door.
 */

const service = require('./entitlement.service');
const cache   = require('./entitlement.cache');
const guard   = require('./entitlement.guard');
const ai      = require('./entitlement.ai');
const jobs    = require('./entitlement.jobs');
const legacy  = require('./entitlement.legacy');
const { requireFeature, mountEntitlementGates } = require('../../middleware/entitlement');

module.exports = {
  service,
  guard,
  /** The AI module's view of a resolved entitlement (phase 2). */
  ai,
  /** The emission gate for background work — crons and notifications (phase 5). */
  jobs,
  /** The legacy fold, shared by the migration script and the first write. */
  legacy,
  /** Exposed so tests and graceful shutdown can drop the in-process entries. */
  cache,
  requireFeature,
  mountEntitlementGates,
};
