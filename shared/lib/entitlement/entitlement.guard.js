'use strict';

/**
 * @file entitlement.guard.js
 * @description The controls an entitlement change must clear before it is
 * written. One implementation for both layers — the ADMIN offer and the
 * CAMPUS_MANAGER usage (design doc §5) — so a rule cannot hold on one route and
 * be forgotten on the other.
 *
 * Two families of control, run in this order:
 *
 *  A. AUTHORITY, per requested override — cheap, declaration-driven:
 *     1. `core`        — never restrictable by anyone, or a manager can remove
 *                        the very screen that switches things back on (§5.1);
 *     2. offer ceiling — a campus override may only restrict what the offer
 *                        grants, never widen it into a module nobody sold (§5);
 *     3. `until`       — in the future and at most MAX_UNTIL_MONTHS ahead, so a
 *                        temporary measure cannot quietly become permanent (D-F).
 *
 *  B. IMPACT, per key that would EFFECTIVELY become hidden — data-driven:
 *     4. record floor  — a floored module holding institutional records may be
 *                        FROZEN but never HIDDEN (§4.1.1);
 *     5. structural use — hiding a module whose rows other collections still
 *                        require on this campus is refused, with the list (§6.3.3).
 *
 * B is computed on the RESOLVED BEFORE/AFTER pair rather than on the submitted
 * override. That is what makes a plan downgrade as safe as a toggle: dropping a
 * campus from `standard` to `free` hides `finance` through the preset, without
 * any override mentioning it, and must be refused just the same when payments
 * exist. Checking the payload alone would let the dangerous path through.
 *
 * Both fail CLOSED, unlike the read path (§4.3): refusing to SERVE a module is
 * packaging; refusing to CHANGE the packaging is a decision to be justified.
 *
 * Blockers are returned, never thrown, and all of them at once — the way the
 * hard-delete impact report does it. A refusal an operator discovers one item
 * at a time is a refusal they will work around.
 */

const {
  FEATURE_STATES,
  STATE_RANK,
  FEATURE_REGISTRY,
  FEATURE_KEYS,
  FEATURE_DEGRADES,
  FEATURE_ERROR_CODES,
  MAX_UNTIL_MONTHS,
} = require('../../constants/features.constants');
const { getFeatureState, OVERRIDE_LAYERS } = require('../../utils/entitlement');
const { findUsageBlockers, findRecordBlockers } = require('./entitlement.usage');

/** @returns {Object} one refusal, carrying the HTTP status the caller should use. */
const blocker = (status, code, message, detail = {}) =>
  ({ status, code, message, ...detail });

/**
 * Validates the optional time box.
 *
 * @param {Date|string|null|undefined} until
 * @param {Date} now
 * @returns {{error: Object|null, value: Date|null}}
 */
const validateUntil = (until, now) => {
  if (until === undefined || until === null || until === '') return { error: null, value: null };

  const value = new Date(until);
  if (Number.isNaN(value.getTime())) {
    return {
      error: blocker(400, FEATURE_ERROR_CODES.FEATURE_UNTIL_INVALID, 'until must be a valid date'),
      value: null,
    };
  }
  if (value.getTime() <= now.getTime()) {
    return {
      error: blocker(400, FEATURE_ERROR_CODES.FEATURE_UNTIL_INVALID, 'until must be in the future'),
      value: null,
    };
  }

  const ceiling = new Date(now);
  ceiling.setMonth(ceiling.getMonth() + MAX_UNTIL_MONTHS);
  if (value.getTime() > ceiling.getTime()) {
    return {
      error: blocker(
        400,
        FEATURE_ERROR_CODES.FEATURE_UNTIL_INVALID,
        `until cannot exceed ${MAX_UNTIL_MONTHS} months — choose a permanent override instead`
      ),
      value: null,
    };
  }
  return { error: null, value };
};

/**
 * Family A — authority controls on one requested override. Synchronous: no
 * database is touched, so an unauthorised change is rejected before any probe.
 *
 * @param {Object} params
 * @param {string} params.key
 * @param {string} params.state
 * @param {Date|string|null} [params.until]
 * @param {string} params.layer - `OVERRIDE_LAYERS.ADMIN` | `.CAMPUS`.
 * @param {Object} params.offer - Resolved entitlement WITHOUT the campus layer:
 *   the ceiling a manager may not exceed. Unused for the admin layer, which has
 *   no ceiling above it.
 * @param {Date}   [params.now]
 * @returns {{blockers: Array, until: Date|null}}
 */
const checkOverrideAuthority = ({ key, state, until, layer, offer, now = new Date() }) => {
  const blockers = [];

  if (!FEATURE_KEYS.includes(key)) {
    return {
      blockers: [blocker(400, FEATURE_ERROR_CODES.FEATURE_DISABLED, `Unknown feature '${key}'`, { feature: key })],
      until: null,
    };
  }
  if (!Object.values(FEATURE_STATES).includes(state)) {
    return {
      blockers: [blocker(400, FEATURE_ERROR_CODES.FEATURE_DISABLED,
        `state must be one of: ${Object.values(FEATURE_STATES).join(', ')}`, { feature: key })],
      until: null,
    };
  }

  const entry = FEATURE_REGISTRY[key];

  // 1. Core — refused before anything else, the ADMIN included. The point of
  // the core list is that no actor, however privileged, can produce a campus
  // that has to be repaired by hand in the database.
  if (entry.core && state !== FEATURE_STATES.ENABLED) {
    blockers.push(blocker(
      409,
      FEATURE_ERROR_CODES.FEATURE_CORE,
      `'${entry.label}' is a core module and cannot be restricted`,
      { feature: key }
    ));
  }

  // 2. Offer ceiling — the usage layer restricts, never widens (§5).
  if (layer === OVERRIDE_LAYERS.CAMPUS) {
    const ceiling = getFeatureState(offer, key);
    if (STATE_RANK[state] > STATE_RANK[ceiling]) {
      blockers.push(blocker(
        403,
        FEATURE_ERROR_CODES.FEATURE_NOT_IN_OFFER,
        `'${entry.label}' is limited to '${ceiling}' by the campus offer`,
        { feature: key, offerState: ceiling }
      ));
    }
  }

  // 3. Time box.
  const { error: untilError, value } = validateUntil(until, now);
  if (untilError) blockers.push({ ...untilError, feature: key });

  return { blockers, until: value };
};

/**
 * Family B — impact controls on every key that would effectively DISAPPEAR.
 *
 * Only `hidden` is probed: freezing keeps every row readable, so it can neither
 * break a consumer nor bury a record. That asymmetry is the whole reason
 * `read_only` exists (§4.1).
 *
 * @param {Object} before   - Resolved entitlement as it stands today.
 * @param {Object} after    - Resolved entitlement as it would stand.
 * @param {string} campusId
 * @returns {Promise<{blockers: Array, warnings: Array}>}
 */
const checkHiddenTransitions = async (before, after, campusId) => {
  const disappearing = FEATURE_KEYS.filter((key) =>
    getFeatureState(after, key) === FEATURE_STATES.HIDDEN &&
    getFeatureState(before, key) !== FEATURE_STATES.HIDDEN);

  const blockers = [];
  const warnings = [];

  const results = await Promise.all(disappearing.map(async (key) => {
    const entry = FEATURE_REGISTRY[key];
    const [records, used] = await Promise.all([
      entry.minState ? findRecordBlockers(key, campusId) : Promise.resolve([]),
      findUsageBlockers(key, campusId),
    ]);
    return { key, entry, records, used };
  }));

  for (const { key, entry, records, used } of results) {
    if (records.length) {
      blockers.push(blocker(
        409,
        FEATURE_ERROR_CODES.FEATURE_HAS_RECORDS,
        `'${entry.label}' holds records on this campus — freeze it (read_only) instead of hiding it`,
        { feature: key, records: records.map((r) => r.label) }
      ));
    }
    if (used.length) {
      blockers.push(blocker(
        409,
        FEATURE_ERROR_CODES.FEATURE_IN_USE,
        `'${entry.label}' is still in use on this campus`,
        { feature: key, blockedBy: used.map((u) => u.label) }
      ));
    }

    // Soft edges never refuse — they ARE the impact preview (§6.3.1): "hiding
    // Finance removes two tiles from the campus dashboard".
    for (const dependant of FEATURE_DEGRADES[key] || []) {
      if (getFeatureState(after, dependant) !== FEATURE_STATES.HIDDEN) {
        warnings.push({ feature: key, degrades: dependant, label: FEATURE_REGISTRY[dependant].label });
      }
    }
  }

  return { blockers, warnings };
};

module.exports = { checkOverrideAuthority, checkHiddenTransitions, validateUntil };
