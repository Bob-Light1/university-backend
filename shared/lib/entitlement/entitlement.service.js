'use strict';

/**
 * @file entitlement.service.js
 * @description The only code path that reads or writes a campus entitlement.
 *
 * Everything above it — the gate, the two PATCH routes, the hydration endpoint —
 * goes through these four functions, so the cache can never be stale because a
 * new route forgot to invalidate it, and an audit row can never be missing
 * because a controller wrote directly. Same shape as
 * `shared/lib/hard-delete/hard-delete.service.js`: an allowlist with one door.
 *
 * Campus persistence is reached through the campus FACADE, lazily required —
 * campus is a module hub and a static require would create a cycle (see the
 * note at the top of `campus.service.js`). No model is touched here (§15bis.3).
 */

const {
  FEATURE_REGISTRY,
  FEATURE_KEYS,
  FEATURE_PLANS,
  FEATURE_ERROR_CODES,
} = require('../../constants/features.constants');
const {
  resolveEntitlement,
  planBaseState,
  getFeatureState,
  ALL_ENABLED,
  OVERRIDE_LAYERS,
} = require('../../utils/entitlement');
const cache = require('./entitlement.cache');
const { foldLegacyEntitlement } = require('./entitlement.legacy');
const { checkOverrideAuthority, checkHiddenTransitions } = require('./entitlement.guard');

/** Lazy facade access — see the file header. */
const campusService = () => require('../../../modules/campus').service;

/**
 * Raw stored entitlement of a campus, or null when it has none (a campus
 * predating the system, or one nobody has configured yet).
 *
 * @param {string} campusId
 * @returns {Promise<{entitlement: Object|null, campusName: string|null}>}
 */
const readRaw = async (campusId) => {
  const campus = await campusService().getCampusEntitlement(campusId);
  return {
    entitlement: campus?.entitlement || null,
    campusName: campus?.campus_name || null,
    found: Boolean(campus),
    /** The lean document, so a write can fold the legacy fields (§3.2). */
    campus: campus || null,
  };
};

/**
 * Effective entitlement of a campus, cached for {@link cache.TTL_MS}.
 *
 * A campus that cannot be read resolves to {@link ALL_ENABLED} — fail-open
 * (§4.3). A transient database hiccup must degrade into "the platform works"
 * and never into "every module of every tenant just vanished".
 *
 * @param {string} campusId
 * @returns {Promise<Object>} frozen resolved entitlement.
 */
const resolveForCampus = async (campusId) => {
  const key = String(campusId);
  const cached = cache.get(key);
  if (cached) return cached;

  const { entitlement } = await readRaw(key);
  const resolved = resolveEntitlement(entitlement);
  cache.set(key, resolved);
  return resolved;
};

/**
 * The ceiling a CAMPUS_MANAGER may not exceed: the plan plus the ADMIN layer,
 * with the campus layer stripped out (§5).
 *
 * @param {Object|null} raw
 * @returns {Object} resolved entitlement.
 */
const resolveOffer = (raw) =>
  resolveEntitlement(raw
    ? { ...raw, modules: (raw.modules || []).filter((m) => m.setBy !== OVERRIDE_LAYERS.CAMPUS) }
    : null);

/**
 * Full picture for a pilot screen: effective state, offer ceiling, and the
 * registry metadata the UI needs (label, core, plan tier, why it is floored).
 *
 * @param {string} campusId
 * @returns {Promise<Object>}
 */
const describeForCampus = async (campusId) => {
  const { entitlement, campusName, found } = await readRaw(campusId);
  const effective = resolveEntitlement(entitlement);
  const offer = resolveOffer(entitlement);
  const overrides = entitlement?.modules || [];

  return {
    campusId: String(campusId),
    campusName,
    found,
    plan: effective.plan,
    quotas: effective.quotas,
    features: FEATURE_KEYS.map((key) => {
      const entry = FEATURE_REGISTRY[key];
      // BOTH layers are reported, never "the first one found": a module can
      // carry an offer override AND a usage override at the same time, and the
      // two answer different questions on screen — "what was sold to this
      // campus" versus "what its manager chose to switch off". Collapsing them
      // shows the admin decision on the manager's screen and vice versa.
      const layerOf = (setBy) => {
        const found = overrides.find((o) => o.key === key && o.setBy === setBy);
        return found
          ? { state: found.state, until: found.until, reason: found.reason, setBy: found.setBy, setAt: found.setAt }
          : null;
      };
      return {
        key,
        label: entry.label,
        core: entry.core,
        minPlan: entry.minPlan,
        minState: entry.minState,
        /** What this campus effectively gets today. */
        state: getFeatureState(effective, key),
        /** The ceiling the usage layer may not exceed. */
        offerState: getFeatureState(offer, key),
        /** What the tier alone would give — how the UI shows "included in plan" vs "override". */
        planState: planBaseState(effective.plan, key),
        overrides: { admin: layerOf(OVERRIDE_LAYERS.ADMIN), campus: layerOf(OVERRIDE_LAYERS.CAMPUS) },
      };
    }),
  };
};

/**
 * Applies a patch to a stored sub-object (`quotas`, `ai`) — the two parts of an
 * entitlement that carry VALUES rather than states, and which therefore cannot
 * be expressed as module overrides.
 *
 * Rules, deliberately few:
 *  - an absent key leaves the stored value alone (a partial patch is a patch,
 *    not a replacement — the AI console sends one field at a time);
 *  - `null` REMOVES the key, which is how a deviation is handed back to the
 *    preset that governs it (§3: only the deviations are stored, so "no
 *    deviation" has to be expressible);
 *  - a nested object recurses one level, so `{ ai: { features: { chat: false } } }`
 *    does not wipe the sibling flags.
 *
 * @param {Object|undefined} current
 * @param {Object} patch
 * @returns {Object|undefined} the merged value, or undefined when nothing is left.
 */
const mergePatch = (current, patch) => {
  const next = { ...(current || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const merged = mergePatch(next[key], value);
      if (merged === undefined) delete next[key];
      else next[key] = merged;
    } else {
      next[key] = value;
    }
  }
  return Object.keys(next).length ? next : undefined;
};

/**
 * Drops overrides that no longer say anything: a permanent override equal to
 * what the layer underneath already gives. The stored array must hold ONLY the
 * deviations (§3) — a redundant entry is a decision nobody made that will
 * silently survive the next plan change.
 *
 * A time-boxed override is kept even when redundant: `until` is a statement
 * about the future ("premium until March"), not about today.
 *
 * @param {Array}  overrides
 * @param {string} plan
 * @returns {Array}
 */
const pruneRedundant = (overrides, plan) =>
  overrides.filter((override) => {
    if (override.until) return true;
    if (override.setBy === OVERRIDE_LAYERS.ADMIN) {
      return override.state !== planBaseState(plan, override.key);
    }
    // Campus layer: redundant against the offer beneath it.
    const beneath = overrides.find(
      (o) => o.key === override.key && o.setBy === OVERRIDE_LAYERS.ADMIN
    );
    const base = beneath ? beneath.state : planBaseState(plan, override.key);
    return override.state !== base;
  });

/**
 * Applies a set of changes to one campus, on ONE layer.
 *
 * @param {Object} params
 * @param {string} params.campusId
 * @param {string} params.layer   - `OVERRIDE_LAYERS.ADMIN` | `.CAMPUS`.
 * @param {Object} params.actor   - `req.user` — `{ id, role }`.
 * @param {string} [params.plan]  - ADMIN layer only; ignored otherwise.
 * @param {Array}  [params.modules] - `[{ key, state, until, reason }]`.
 * @param {Object} [params.quotas]  - Partial `{ maxStudents, …, aiMonthlyTokens }`
 *   patch. ADMIN layer only: a quota is what was SOLD, so a manager setting
 *   their own would be a manager writing their own bill.
 * @param {Object} [params.ai]      - Partial `{ llmProfile, features }` patch,
 *   same layer rule and same reason (phase 2 — the AI joins the grid).
 * @param {Date}   [params.now]
 * @returns {Promise<{ok: boolean, blockers?: Array, warnings?: Array, entitlement?: Object, resolved?: Object}>}
 */
const applyChanges = async ({
  campusId, layer, actor, plan, modules = [], quotas, ai, now = new Date(),
}) => {
  const { entitlement: stored, found, campus } = await readRaw(campusId);
  if (!found) return { ok: false, notFound: true };

  // A campus the migration has not covered yet is folded from its legacy
  // configuration BEFORE anything is applied. Storing the submitted change on
  // its own would give the campus a tier with no grandfathering behind it, and
  // every module outside that tier — used daily until then — would disappear as
  // a side effect of an unrelated edit. The read path deliberately does not do
  // this; see the header of `entitlement.legacy.js` for the asymmetry.
  const foldedLegacy = !stored;
  const raw = stored || foldLegacyEntitlement(campus, { now, actorId: actor?.id || null });

  const before = resolveEntitlement(raw, { now });
  const offer = resolveOffer(raw);

  // ── Family A — authority, before any database probe ──────────────────────
  const authority = [];
  const validated = [];
  for (const change of modules) {
    const { blockers, until } = checkOverrideAuthority({
      key: change.key, state: change.state, until: change.until, layer, offer, now,
    });
    authority.push(...blockers);
    if (!blockers.length) validated.push({ ...change, until });
  }
  if (plan !== undefined && !Object.values(FEATURE_PLANS).includes(plan)) {
    authority.push({
      status: 400,
      code: FEATURE_ERROR_CODES.FEATURE_PLAN_INVALID,
      message: `plan must be one of: ${Object.values(FEATURE_PLANS).join(', ')}`,
    });
  }
  // Shape only. What a quota or an AI profile MEANS belongs to whoever owns the
  // vocabulary — the AI console validates its own fields, the schema enforces
  // the ranges. This door stays ignorant of both, which is what lets it serve
  // every module without growing a branch per module.
  for (const [field, patch] of [['quotas', quotas], ['ai', ai]]) {
    if (patch !== undefined && (typeof patch !== 'object' || patch === null || Array.isArray(patch))) {
      authority.push({
        status: 400,
        code: FEATURE_ERROR_CODES.FEATURE_PATCH_INVALID,
        message: `${field} must be an object`,
      });
    }
  }
  if (authority.length) return { ok: false, blockers: authority };

  // ── Candidate next value ─────────────────────────────────────────────────
  const nextPlan = layer === OVERRIDE_LAYERS.ADMIN && plan !== undefined
    ? plan
    : (raw?.plan ?? undefined);

  const kept = (raw?.modules || []).filter((existing) =>
    !(existing.setBy === layer && validated.some((c) => c.key === existing.key)));

  const written = validated.map((change) => ({
    key: change.key,
    state: change.state,
    until: change.until,
    reason: (change.reason || '').trim(),
    setBy: layer,
    setAt: now,
    setById: actor?.id || null,
  }));

  // Values follow the same layer rule as the plan: the offer sets them, the
  // usage layer never does, and submitting one there is inert rather than an
  // error (the route above refuses it explicitly, so it cannot arrive by hand).
  const isOffer = layer === OVERRIDE_LAYERS.ADMIN;
  const nextQuotas = isOffer && quotas ? mergePatch(raw?.quotas, quotas) : raw?.quotas;
  const nextAi     = isOffer && ai     ? mergePatch(raw?.ai, ai)         : raw?.ai;

  const nextRaw = {
    ...(raw || {}),
    ...(nextPlan !== undefined ? { plan: nextPlan } : {}),
    ...(nextQuotas !== undefined ? { quotas: nextQuotas } : {}),
    ...(nextAi !== undefined ? { ai: nextAi } : {}),
    modules: pruneRedundant([...kept, ...written], nextPlan),
  };
  // `mergePatch` returning undefined means the last deviation was cleared —
  // the key must then LEAVE the stored object, not linger as an empty husk that
  // reads as "configured" on the pilot screen.
  if (nextQuotas === undefined) delete nextRaw.quotas;
  if (nextAi === undefined) delete nextRaw.ai;

  // ── Family B — impact, on the effective before/after pair ────────────────
  const after = resolveEntitlement(nextRaw, { now });
  const { blockers, warnings } = await checkHiddenTransitions(before, after, campusId);
  if (blockers.length) return { ok: false, blockers, warnings };

  // ── Write + audit + invalidate, in that order ────────────────────────────
  const updated = await campusService().setCampusEntitlement(campusId, nextRaw, {
    at: now,
    actorId: actor?.id,
    actorRole: actor?.role,
    changes: {
      layer,
      ...(foldedLegacy ? { foldedLegacy: true } : {}),
      ...(plan !== undefined && isOffer ? { plan } : {}),
      ...(quotas !== undefined && isOffer ? { quotas } : {}),
      ...(ai !== undefined && isOffer ? { ai } : {}),
      modules: written.map(({ key, state, until, reason }) => ({ key, state, until, reason })),
    },
  });
  cache.bump(campusId);

  return {
    ok: true,
    warnings,
    entitlement: updated?.entitlement || nextRaw,
    resolved: after,
  };
};

module.exports = {
  ALL_ENABLED,
  readRaw,
  resolveForCampus,
  resolveOffer,
  describeForCampus,
  pruneRedundant,
  mergePatch,
  applyChanges,
};
