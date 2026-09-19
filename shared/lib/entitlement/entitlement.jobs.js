'use strict';

/**
 * @file entitlement.jobs.js
 * @description The entitlement gate for BACKGROUND work — the part of the
 * chantier that has no HTTP request to hang off (design doc §9.1 and §9.4).
 *
 * `shared/middleware/entitlement.js` answers "may this request proceed?" and
 * gets its campus from a JWT. A cron has neither: it sweeps the whole estate on
 * a timer, and nothing in the request path ever sees it. Left alone, disabling
 * Finance for a campus does not stop the 06:00 job from mailing that campus's
 * students dunning notices — outbound email in the name of a module the
 * operator was told was switched off. That is the incident this file exists to
 * prevent, and it is the one the client notices.
 *
 * ── THE RULE: SILENCE THE EMISSION, NEVER THE HYGIENE ───────────────────────
 * "Module off ⇒ job off" is wrong, and dangerously so for two of the eight.
 * `document-retention` answers a legal duty (stopping it keeps personal data
 * past its lawful period — a silent compliance breach); `print-queue-sweep`
 * drains in-flight jobs (stopping it hangs them forever). Each cron therefore
 * declares its NATURE in `shared/constants/features.constants.js`, and only the
 * emission is gated. Some jobs are both: `competition-closing` settles the
 * ranking whatever happens and only withholds the winner mails.
 *
 * ── WHY ENABLED, AND NOT MERELY "NOT HIDDEN" ────────────────────────────────
 * Emission is a mutation of the outside world, so it reads through
 * `isFeatureActive(..., { write: true })` — the same predicate the HTTP gate
 * uses to refuse a POST. A frozen module (`read_only`) keeps its history
 * readable and stops acting: mailing a payment reminder from a ledger the
 * operator has just frozen would contradict, by email, what the screen says.
 * The rule is written ONCE, in the resolver, and never restated here.
 *
 * ── FAIL-OPEN, LIKE EVERYTHING ELSE IN THIS SYSTEM (§4.3) ───────────────────
 * A campus that cannot be read emits. A job silently skipping a whole estate
 * because a lookup failed is an outage nobody would attribute to entitlement
 * for days; a job emitting a little too much is a support ticket.
 */

const {
  FEATURE_CRONS,
  FEATURE_REGISTRY,
  CRON_NATURE,
} = require('../../constants/features.constants');
const { resolveEntitlement, isFeatureActive } = require('../../utils/entitlement');
const service = require('./entitlement.service');

/** Lazy facade access — same cycle-avoidance rule as the service. */
const campusService = () => require('../../../modules/campus').service;

/**
 * The jobs that emit, and the feature governing what they emit.
 *
 * Declared here rather than derived from `nature` alone, because nature is a
 * property of a JOB and emission is a property of a SITE inside it:
 * `competition-closing` is hygiene (it must always settle the ranking) yet
 * carries one emission — the winner notifications. Deriving would either gate
 * the whole job or gate nothing.
 *
 * `tests/unit/entitlement.jobs.test.js` pins both directions: every cron the
 * registry marks EMISSION must appear here (a new emitting job cannot ship
 * unwired), and every name here must be a real canonical job owned by the
 * feature it names (a renamed job cannot leave a dead gate behind).
 */
const EMISSION_SITES = Object.freeze({
  'finance-overdue':     'finance',
  'finance-due-soon':    'finance',
  'exam-anticheat':      'exam',
  'competition-closing': 'public-portal',
});

/**
 * Whether `feature` may emit for `campusId`.
 *
 * Reads through the service cache (TTL 60 s), so a job iterating thousands of
 * rows across a handful of campuses pays one database read per campus per
 * minute, not one per row.
 *
 * @param {string|import('mongoose').Types.ObjectId} campusId
 * @param {string} feature - Key of `FEATURE_REGISTRY`.
 * @returns {Promise<boolean>} — true (emit) whenever the answer is unknown.
 */
const isEmissionAllowed = async (campusId, feature) => {
  if (!campusId) return true;               // nothing to scope on — fail-open
  // A core module is ENABLED for everyone by construction (§5.1), so the answer
  // is known without a lookup. It is not a micro-optimisation: `account.*` are
  // the activation and welcome mails, sent one per created account, and nobody
  // should pay a cache miss to re-learn that the account module cannot be off.
  if (FEATURE_REGISTRY[feature]?.core) return true;
  try {
    const resolved = await service.resolveForCampus(String(campusId));
    return isFeatureActive(resolved, feature, { write: true });
  } catch {
    return true;                            // §4.3
  }
};

/**
 * The campuses `feature` may NOT emit for, as ids ready for a `$nin`.
 *
 * The per-row predicate above is the wrong shape for a job that CLAIMS its work
 * atomically: `finance-overdue` stamps `lastRemindedAt` and bumps
 * `reminderCount` the moment it picks a debt up, so a reminder discarded after
 * the claim would still consume the dunning cadence — the campus would be
 * silenced today and then find its debts un-remindable for another week once
 * the module came back. Same story for `exam-anticheat`, which would hand back
 * batches of sessions it is not allowed to scan and starve the ones it is.
 * Excluding the campuses inside the QUERY keeps the candidate set honest.
 *
 * Only campuses carrying a configured entitlement can be suppressed — every
 * other one resolves to everything-enabled (§4.3) — so this scan is bounded by
 * the campuses somebody configured, and it runs once per job, never per row.
 *
 * @param {string} feature - Key of `FEATURE_REGISTRY`.
 * @returns {Promise<Array>} campus ids; empty whenever the answer is unknown.
 */
const suppressedCampusIds = async (feature) => {
  if (FEATURE_REGISTRY[feature]?.core) return [];   // never suppressible (§5.1)
  try {
    const campuses = await campusService().listCampusEntitlements();
    return campuses
      .filter((campus) => !isFeatureActive(resolveEntitlement(campus.entitlement), feature, { write: true }))
      .map((campus) => campus._id);
  } catch {
    return [];                              // §4.3 — emit rather than skip an estate
  }
};

/**
 * The feature governing a job's emission, or null when the job emits nothing.
 * Used by the tests and by any future job wiring; jobs themselves name their
 * feature explicitly at the call site, which is what makes the site greppable.
 *
 * @param {string} jobName - Canonical name from `projectJobs()`.
 * @returns {string|null}
 */
const emissionFeatureOf = (jobName) => EMISSION_SITES[jobName] || null;

/**
 * Every cron the registry marks EMISSION. Exported for the drift test, which
 * asserts this set is covered by {@link EMISSION_SITES}.
 * @returns {string[]}
 */
const declaredEmissionJobs = () =>
  FEATURE_CRONS.filter((cron) => cron.nature === CRON_NATURE.EMISSION).map((cron) => cron.name);

/**
 * The feature owning a job in the registry — the pairing {@link EMISSION_SITES}
 * is checked against.
 * @param {string} jobName
 * @returns {string|undefined}
 */
const featureOwningJob = (jobName) =>
  FEATURE_CRONS.find((cron) => cron.name === jobName)?.feature;

module.exports = {
  EMISSION_SITES,
  isEmissionAllowed,
  suppressedCampusIds,
  emissionFeatureOf,
  declaredEmissionJobs,
  featureOwningJob,
  /** Re-exported so a caller never reaches into the registry for a label. */
  labelOf: (feature) => FEATURE_REGISTRY[feature]?.label || feature,
};
