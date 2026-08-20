'use strict';

/**
 * @file features.constants.js
 * @description Per-campus entitlement registry — single source of truth for
 * WHAT can be enabled, disabled or frozen on a campus, and WHAT each decision
 * touches (dependencies, routers, crons, records).
 *
 * Design doc: `docs/architecture/CAMPUS_ENTITLEMENT_DESIGN.md`.
 * This file is the phase 0 deliverable: declarations only, no behaviour. The
 * resolver (`shared/utils/entitlement.js`) and the gate
 * (`shared/middleware/entitlement.js`) consume it in phase 1.
 *
 * Mirrored verbatim by the frontend (labels via i18n `common.features.*`);
 * the backend is the source of truth for keys, states and plans (CLAUDE.md §0.1).
 *
 * IMPORTANT — this is NOT a security boundary. Entitlement is commercial
 * packaging: it fails OPEN (an unknown or missing key means "enabled"), unlike
 * `buildCampusFilter()` / `notDeletedFilter()` which fail closed. See §4.3 of
 * the design doc before changing that.
 *
 * IMPORTANT — the gate applies to the HTTP surface, never to data access.
 * A hidden module stops serving its own routes; the rows it owns stay readable
 * by other modules through their facades. Without this rule, hiding `level`
 * would cascade into `class`, which references it through a required key.
 */

// ─── States ───────────────────────────────────────────────────────────────────

/**
 * The three states a feature can take on a campus (design doc §4.1).
 * `read_only` keeps the history readable while refusing every mutation — it is
 * the correct answer to "this campus must stop using X", never `hidden`.
 */
const FEATURE_STATES = Object.freeze({
  ENABLED:   'enabled',
  READ_ONLY: 'read_only',
  HIDDEN:    'hidden',
});

/**
 * Ordering used to compare states and apply floors: a campus override may only
 * ever LOWER the effective state, never raise it above what the offer grants.
 */
const STATE_RANK = Object.freeze({
  [FEATURE_STATES.HIDDEN]:    0,
  [FEATURE_STATES.READ_ONLY]: 1,
  [FEATURE_STATES.ENABLED]:   2,
});

// ─── Plans ────────────────────────────────────────────────────────────────────

/**
 * Commercial tiers. Deliberately identical to `AI_PLANS`
 * (`shared/constants/ai.constants.js`, decision D-D): one grid for the whole
 * platform, AI included — never two pricing vocabularies.
 * `CUSTOM` carries no preset: its feature set comes entirely from explicit
 * per-campus overrides.
 */
const FEATURE_PLANS = Object.freeze({
  FREE:     'free',
  STANDARD: 'standard',
  PREMIUM:  'premium',
  CUSTOM:   'custom',
});

/** Ordering used to derive the plan presets from each entry's `minPlan`. */
const PLAN_RANK = Object.freeze({
  [FEATURE_PLANS.FREE]:     0,
  [FEATURE_PLANS.STANDARD]: 1,
  [FEATURE_PLANS.PREMIUM]:  2,
});

// ─── Crons ────────────────────────────────────────────────────────────────────

/**
 * Why a scheduled job runs — decides whether disabling the module silences it
 * (design doc §9.1). The rule is "silence the emission, never the hygiene".
 *
 *  - EMISSION: the job produces something outward-facing (email, notification,
 *    document, user-visible state change). A disabled module must emit nothing.
 *  - HYGIENE : the job purges, expires, drains or closes. It MUST keep running
 *    whatever the state — these answer legal retention duties or prevent stuck
 *    states, and nothing they do is visible to a user. Stopping the document
 *    retention sweep, for instance, keeps personal data beyond its lawful
 *    period: a silent compliance breach, not a UX detail.
 */
const CRON_NATURE = Object.freeze({
  EMISSION: 'emission',
  HYGIENE:  'hygiene',
});

// ─── Error codes ──────────────────────────────────────────────────────────────

/**
 * Dedicated codes travelling in `errors.code`. A bare 403 is indistinguishable
 * from a role refusal on the frontend, which makes the in-flight write case
 * (design doc §8.3) impossible to handle properly: the axios interceptor keys
 * off these to re-hydrate the flags and refresh the navigation instead of
 * showing "forbidden". Mirrored by the frontend, never re-declared there.
 *
 * The first two are raised by the gate; the others by the toggle guard, which
 * refuses a mutation of the entitlement itself.
 */
const FEATURE_ERROR_CODES = Object.freeze({
  /** Gate: the module is hidden for this campus. */
  FEATURE_DISABLED:      'FEATURE_DISABLED',
  /** Gate: the module is frozen — reads pass, this write does not. */
  FEATURE_READ_ONLY:     'FEATURE_READ_ONLY',
  /** Guard: `core` module, non-negotiable for anyone (§5.1). */
  FEATURE_CORE:          'FEATURE_CORE',
  /** Guard: a campus override may only restrict what the offer already grants (§5). */
  FEATURE_NOT_IN_OFFER:  'FEATURE_NOT_IN_OFFER',
  /** Guard: floored module holding records — freeze it, never hide it (§4.1.1). */
  FEATURE_HAS_RECORDS:   'FEATURE_HAS_RECORDS',
  /** Guard: an active module structurally needs this one on this campus (§6.3.3). */
  FEATURE_IN_USE:        'FEATURE_IN_USE',
  /** Guard: `until` beyond MAX_UNTIL_MONTHS, or already in the past (D-F). */
  FEATURE_UNTIL_INVALID: 'FEATURE_UNTIL_INVALID',
  /** Guard: the submitted `plan` is not one of FEATURE_PLANS. */
  FEATURE_PLAN_INVALID:  'FEATURE_PLAN_INVALID',
  /** Guard: a `quotas` / `ai` patch that is not a plain object (phase 2). */
  FEATURE_PATCH_INVALID: 'FEATURE_PATCH_INVALID',
});

// ─── Limits ───────────────────────────────────────────────────────────────────

/**
 * Upper bound for a time-boxed override (decision D-F). Beyond this the
 * operator must choose "permanent" explicitly, so that a temporary measure
 * cannot quietly become a permanent one nobody reviews.
 */
const MAX_UNTIL_MONTHS = 12;

// ─── Registry ─────────────────────────────────────────────────────────────────

/**
 * Every mounted surface of the platform, keyed by MODULE DIRECTORY NAME
 * (`modules/<key>/`) — not by route, because a module may mount several routes
 * and the coverage test walks `modules/`.
 *
 * Per-entry contract:
 *  - `label`      : English display name; the frontend renders `common.features.<key>`.
 *  - `core`       : true → always ENABLED, non-negotiable for anyone (design doc §5.1).
 *  - `minState`   : floor. `READ_ONLY` means "may be frozen, never hidden, ONCE it
 *                   holds records" — hiding stays legal while `records` are empty.
 *  - `records`    : models checked for emptiness before allowing HIDDEN. Only
 *                   meaningful alongside `minState`.
 *  - `dependsOn`  : HARD edges — modules whose entities this one references through a
 *                   `required` foreign key. Structural: without them its own rows
 *                   cannot exist. Derived from the models on 2026-08-13, not from
 *                   `require()` statements. `requiredBy` is DERIVED from these
 *                   (never declared twice — CLAUDE.md §0.1).
 *  - `usesWhenAvailable` : SOFT edges — facade calls that enrich a dashboard or a
 *                   side panel and degrade gracefully when the other module is off.
 *                   They NEVER refuse a toggle; they feed the impact preview
 *                   ("disabling Finance removes 2 tiles from the campus dashboard"),
 *                   mirroring the hard-delete impact report.
 *  - `routers`    : mount paths in `app.js`, used by the coverage test.
 *  - `minPlan`    : lowest tier including the module. Presets are derived from it.
 *  - `crons`      : scheduled jobs owned by the module, with their nature.
 *
 * A hard edge does NOT by itself refuse a toggle: the refusal is data-driven,
 * exactly like `shared/lib/hard-delete/hard-delete.registry.js`. Hiding `subject`
 * is legal on a campus with no timetable and refused on one that has some. The
 * per-edge filters land in phase 1 alongside the resolver.
 *
 * Adding a module: declare it here and nothing else — the gate, the presets and
 * the admin UI are generic. `tests/unit/feature-registry.test.js` fails if a
 * router is mounted in `app.js` without a matching entry.
 */
const FEATURE_REGISTRY = Object.freeze({
  // ── Core (8 modules + 1 governance mount) — never disabled by anyone ───────

  account: {
    label: 'Accounts & activation', core: true, minState: null, records: [],
    dependsOn: [], usesWhenAvailable: ['notification'],
    routers: ['/api/account'], minPlan: FEATURE_PLANS.FREE, crons: [],
  },
  settings: {
    // 13 dependants — and it hosts the entitlement panel itself: disabling it
    // would remove the only screen able to re-enable anything.
    label: 'Settings', core: true, minState: null, records: [],
    dependsOn: [], usesWhenAvailable: ['campus'],
    routers: ['/api/settings'], minPlan: FEATURE_PLANS.FREE, crons: [],
  },
  campus: {
    // Root of the multi-tenant model: every scoped collection points at it.
    // Owns no hard edge of its own — its many facade calls are dashboard tiles.
    label: 'Campuses', core: true, minState: null, records: [],
    dependsOn: [],
    usesWhenAvailable: ['class', 'department', 'finance', 'mentor', 'settings', 'staff', 'student', 'subject', 'teacher'],
    routers: ['/api/campus'], minPlan: FEATURE_PLANS.FREE, crons: [],
  },
  admin: {
    label: 'Platform administration', core: true, minState: null, records: [],
    dependsOn: [], usesWhenAvailable: ['campus', 'notification', 'settings'],
    routers: ['/api/admin'], minPlan: FEATURE_PLANS.FREE, crons: [],
  },
  notification: {
    // Delivery backbone of every other module. The retry job drains the whole
    // platform, so it is hygiene rather than any single module's emission.
    label: 'Notifications', core: true, minState: null, records: [],
    dependsOn: [], usesWhenAvailable: [],
    routers: ['/api/notifications'], minPlan: FEATURE_PLANS.FREE,
    crons: [{ name: 'notification-retry', nature: CRON_NATURE.HYGIENE }],
  },
  student: {
    label: 'Students', core: true, minState: null, records: [],
    dependsOn: ['campus', 'class', 'subject', 'teacher'],
    usesWhenAvailable: ['exam', 'parent', 'result', 'settings'],
    routers: ['/api/students', '/api/schedules/student', '/api/attendance/student'],
    minPlan: FEATURE_PLANS.FREE, crons: [],
  },
  teacher: {
    label: 'Teachers', core: true, minState: null, records: [],
    dependsOn: ['campus', 'class', 'department', 'subject'],
    usesWhenAvailable: ['exam', 'settings', 'student'],
    routers: ['/api/teachers', '/api/schedules/teacher', '/api/attendance/teacher'],
    minPlan: FEATURE_PLANS.FREE, crons: [],
  },
  class: {
    label: 'Classes', core: true, minState: null, records: [],
    dependsOn: ['campus', 'level'], usesWhenAvailable: ['teacher'],
    routers: ['/api/class'], minPlan: FEATURE_PLANS.FREE, crons: [],
  },
  'danger-zone': {
    // Mounted from `shared/lib/hard-delete`, not from `modules/` — declared
    // here so the coverage test sees every gated mount. Core: the permanent
    // deletion gate and its audit ledger are never negotiable.
    label: 'Permanent deletion', core: true, minState: null, records: [],
    dependsOn: [], usesWhenAvailable: [],
    routers: ['/api/danger-zone'], minPlan: FEATURE_PLANS.FREE, crons: [],
  },

  // ── Floored (4) — freezable, hideable only while empty (design doc §4.1.1) ──
  // Rationale: every model listed in `records` is declared BLOCK in
  // `shared/lib/hard-delete/hard-delete.registry.js`. A record the platform
  // refuses to delete is a record it must equally refuse to hide.

  result: {
    label: 'Results & transcripts', core: false,
    minState: FEATURE_STATES.READ_ONLY, records: ['Result', 'FinalTranscript'],
    dependsOn: ['campus', 'class', 'student', 'subject', 'teacher'],
    usesWhenAvailable: ['notification', 'settings'],
    routers: ['/api/results'], minPlan: FEATURE_PLANS.FREE, crons: [],
  },
  finance: {
    label: 'Finance', core: false,
    minState: FEATURE_STATES.READ_ONLY, records: ['FeePayment', 'Income'],
    dependsOn: ['campus', 'student'], usesWhenAvailable: ['notification', 'settings'],
    routers: ['/api/finance'], minPlan: FEATURE_PLANS.STANDARD,
    crons: [{ name: 'finance-overdue', nature: CRON_NATURE.EMISSION }],
  },
  exam: {
    label: 'Examinations', core: false,
    minState: FEATURE_STATES.READ_ONLY, records: ['ExamGrading', 'ExamSession'],
    dependsOn: ['campus', 'class', 'student', 'subject', 'teacher'],
    usesWhenAvailable: ['notification', 'settings'],
    routers: ['/api/examination'], minPlan: FEATURE_PLANS.STANDARD,
    crons: [{ name: 'exam-anticheat', nature: CRON_NATURE.EMISSION }],
  },
  document: {
    label: 'Document management', core: false,
    minState: FEATURE_STATES.READ_ONLY, records: ['Document'],
    dependsOn: ['campus'],
    usesWhenAvailable: ['academic-print', 'ai', 'class', 'course', 'parent', 'student', 'teacher'],
    routers: ['/api/documents'], minPlan: FEATURE_PLANS.STANDARD,
    // Retention is a legal duty, not a feature: it runs even when hidden.
    crons: [{ name: 'document-retention', nature: CRON_NATURE.HYGIENE }],
  },

  // ── Freely toggleable (13) ────────────────────────────────────────────────

  subject: {
    // Highest-coupled non-core module (7 dependants, two of them core): expect
    // most refusals here. Kept toggleable because the refusal is data-driven —
    // a campus with no timetable and no result may legitimately hide it.
    label: 'Subjects', core: false, minState: null, records: [],
    dependsOn: ['campus'], usesWhenAvailable: ['class', 'course', 'department'],
    routers: ['/api/subject'], minPlan: FEATURE_PLANS.FREE, crons: [],
  },
  course: {
    label: 'Courses', core: false, minState: null, records: [],
    dependsOn: ['level', 'teacher'], usesWhenAvailable: ['subject'],
    routers: ['/api/courses'], minPlan: FEATURE_PLANS.FREE, crons: [],
  },
  level: {
    // Global collection (no campusId) and a configuration module: once levels
    // exist, hiding the screen removes management, never the data `class` reads.
    label: 'Levels', core: false, minState: null, records: [],
    dependsOn: [], usesWhenAvailable: [],
    routers: ['/api/level'], minPlan: FEATURE_PLANS.FREE, crons: [],
  },
  department: {
    label: 'Departments', core: false, minState: null, records: [],
    dependsOn: ['campus'], usesWhenAvailable: ['teacher'],
    routers: ['/api/department'], minPlan: FEATURE_PLANS.FREE, crons: [],
  },
  parent: {
    label: 'Parents', core: false, minState: null, records: [],
    dependsOn: ['campus'], usesWhenAvailable: ['account', 'result', 'settings', 'student'],
    routers: ['/api/parents'], minPlan: FEATURE_PLANS.FREE, crons: [],
  },
  announcement: {
    label: 'Announcements', core: false, minState: null, records: [],
    dependsOn: ['campus'], usesWhenAvailable: [],
    routers: ['/api/announcements'], minPlan: FEATURE_PLANS.STANDARD,
    // Expiry keeps running: an unexpired announcement stays "live" forever.
    crons: [{ name: 'announcement-expiry', nature: CRON_NATURE.HYGIENE }],
  },
  'academic-print': {
    label: 'Academic printing', core: false, minState: null, records: [],
    dependsOn: ['campus'],
    usesWhenAvailable: ['class', 'document', 'result', 'settings', 'student'],
    routers: ['/api/print'], minPlan: FEATURE_PLANS.STANDARD,
    // Queue sweep keeps running so in-flight jobs drain instead of hanging.
    crons: [{ name: 'print-queue-sweep', nature: CRON_NATURE.HYGIENE }],
  },
  mentor: {
    label: 'Mentors', core: false, minState: null, records: [],
    dependsOn: ['campus'],
    usesWhenAvailable: ['account', 'course', 'result', 'settings', 'student'],
    routers: ['/api/mentors'], minPlan: FEATURE_PLANS.STANDARD, crons: [],
  },
  staff: {
    // Most outbound facade calls (8) but ZERO dependants: terminal consumer,
    // safe to disable. A small campus without HR management is a real case.
    label: 'Staff & roles', core: false, minState: null, records: [],
    dependsOn: ['campus'],
    usesWhenAvailable: ['account', 'course', 'document', 'exam', 'result', 'settings', 'student', 'teacher'],
    routers: ['/api/staff', '/api/staff-roles'],
    minPlan: FEATURE_PLANS.STANDARD, crons: [],
  },
  'public-portal': {
    // PREMIUM by decision (2026-08-14): the portal is a growth lever, sold
    // alongside `partner` and `gaet` rather than as base equipment — and it is
    // functionally tied to `partner` (referral links, lead funnel).
    label: 'Public portal', core: false, minState: null, records: [],
    dependsOn: ['campus'], usesWhenAvailable: ['ai', 'partner'],
    routers: ['/api/public', '/api/portal-admin'], minPlan: FEATURE_PLANS.PREMIUM,
    // Closing settles competition state; winner notifications are emission and
    // are suppressed when the module is not active.
    crons: [{ name: 'competition-closing', nature: CRON_NATURE.HYGIENE }],
  },
  gaet: {
    label: 'Automatic timetabling', core: false, minState: null, records: [],
    dependsOn: ['campus', 'class', 'subject', 'teacher'], usesWhenAvailable: ['student'],
    routers: ['/api/gaet'], minPlan: FEATURE_PLANS.PREMIUM, crons: [],
  },
  partner: {
    label: 'Partners & referrals', core: false, minState: null, records: [],
    dependsOn: ['campus'], usesWhenAvailable: ['notification', 'settings'],
    routers: ['/api/partners'], minPlan: FEATURE_PLANS.PREMIUM, crons: [],
  },
  ai: {
    // Inert without AI_SERVICE_URL by construction, so every edge into it is
    // soft. Sub-features (chat/search/analytics/advisors) and the token budget
    // stay owned by `shared/constants/ai.constants.js`; this entry only governs
    // whether the module exists for the campus at all.
    label: 'AI assistant', core: false, minState: null, records: [],
    dependsOn: [],
    usesWhenAvailable: ['campus', 'document', 'finance', 'partner', 'public-portal', 'result', 'settings', 'student'],
    routers: ['/api/ai'], minPlan: FEATURE_PLANS.PREMIUM, crons: [],
  },
});

/**
 * Mounts deliberately outside the entitlement system. The coverage test
 * tolerates these and ONLY these — anything else mounted in `app.js` without a
 * registry entry is a test failure, not a silent pass.
 *
 *  - `/internal/ai` is S2S-only and never published by the reverse proxy;
 *  - health/ping are infrastructure probes.
 */
const UNGATED_MOUNTS = Object.freeze([
  '/internal/ai',
  '/api/ping',
  '/api/health',
  '/health',
]);

// ─── Derived views (computed once, never declared twice) ──────────────────────

const FEATURE_KEYS = Object.freeze(Object.keys(FEATURE_REGISTRY));

/** Keys that can never be disabled, whatever the plan or the actor (§5.1). */
const CORE_FEATURE_KEYS = Object.freeze(
  FEATURE_KEYS.filter((key) => FEATURE_REGISTRY[key].core)
);

/** Keys carrying institutional records: hideable only while empty (§4.1.1). */
const FLOORED_FEATURE_KEYS = Object.freeze(
  FEATURE_KEYS.filter((key) => FEATURE_REGISTRY[key].minState !== null)
);

/**
 * Reverse edges of `dependsOn`, derived rather than declared so the two lists
 * can never drift apart. `FEATURE_REQUIRED_BY[k]` lists the modules whose rows
 * structurally reference `k` — the candidates a toggle must probe for data
 * before refusing with a 409 (§6.3).
 */
const FEATURE_REQUIRED_BY = Object.freeze(
  FEATURE_KEYS.reduce((acc, key) => {
    acc[key] = Object.freeze(
      FEATURE_KEYS.filter((other) => FEATURE_REGISTRY[other].dependsOn.includes(key))
    );
    return acc;
  }, {})
);

/**
 * Reverse edges of `usesWhenAvailable`: what degrades — but never breaks — when
 * `k` is switched off. Feeds the impact preview shown before a toggle.
 */
const FEATURE_DEGRADES = Object.freeze(
  FEATURE_KEYS.reduce((acc, key) => {
    acc[key] = Object.freeze(
      FEATURE_KEYS.filter((other) => FEATURE_REGISTRY[other].usesWhenAvailable.includes(key))
    );
    return acc;
  }, {})
);

/**
 * Feature set granted by each tier, derived from every entry's `minPlan`.
 * `CUSTOM` is intentionally absent: it grants nothing implicitly and is driven
 * entirely by explicit per-campus overrides.
 */
const PLAN_PRESETS = Object.freeze(
  [FEATURE_PLANS.FREE, FEATURE_PLANS.STANDARD, FEATURE_PLANS.PREMIUM].reduce((acc, plan) => {
    acc[plan] = Object.freeze(
      FEATURE_KEYS.filter((key) => PLAN_RANK[FEATURE_REGISTRY[key].minPlan] <= PLAN_RANK[plan])
    );
    return acc;
  }, {})
);

/** Every declared cron, flattened — consumed by the schedulers in `server.js`. */
const FEATURE_CRONS = Object.freeze(
  FEATURE_KEYS.flatMap((key) =>
    FEATURE_REGISTRY[key].crons.map((cron) => Object.freeze({ ...cron, feature: key }))
  )
);

module.exports = {
  FEATURE_STATES,
  STATE_RANK,
  FEATURE_PLANS,
  PLAN_RANK,
  CRON_NATURE,
  FEATURE_ERROR_CODES,
  MAX_UNTIL_MONTHS,
  FEATURE_REGISTRY,
  UNGATED_MOUNTS,
  FEATURE_KEYS,
  CORE_FEATURE_KEYS,
  FLOORED_FEATURE_KEYS,
  FEATURE_REQUIRED_BY,
  FEATURE_DEGRADES,
  PLAN_PRESETS,
  FEATURE_CRONS,
};
