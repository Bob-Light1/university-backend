'use strict';

/**
 * Folds the two legacy configuration objects of `Campus` into the unified
 * `entitlement` (CAMPUS_ENTITLEMENT_DESIGN.md §10, phase 1.2):
 *
 *   features.max*            → entitlement.quotas.*
 *   aiEntitlement.plan       → entitlement.plan
 *   aiEntitlement.*Budget    → entitlement.quotas.aiMonthlyTokens
 *   aiEntitlement.llmProfile → entitlement.ai.llmProfile
 *
 *   node scripts/migrate-entitlement.js [--dry-run] [--plan=<tier>]
 *
 * ── NOTHING A CAMPUS COULD REACH BEFORE BECOMES UNREACHABLE ──────────────────
 * The plan grid is new. A campus on `free` today has been using Finance,
 * Documents and Exams for months, because until now every campus had
 * everything. Writing the tier alone would hide those modules the moment the
 * script finishes — a self-inflicted outage on every tenant.
 *
 * So every module the target tier does NOT include is GRANDFATHERED: an
 * explicit `setBy: 'admin'` override at `enabled`, permanent, with a reason
 * that says where it came from. From there the ADMIN removes them one by one,
 * deliberately, per campus — which is exactly the upsell conversation the
 * system exists to make possible (§13.2, act 6).
 *
 * Only the DEVIATIONS are written: what the tier already grants stays derived
 * (§3), so the array holds ~10 entries rather than 26.
 *
 * ── IDEMPOTENT ───────────────────────────────────────────────────────────────
 * A campus that already carries an `entitlement` is skipped, never rewritten:
 * re-running the script after an admin has adjusted an offer must not undo
 * their work. Use `--force` to rebuild those too — it discards manual changes,
 * so it prints what it would drop first.
 *
 * `--dry-run` reads and reports; it writes nothing.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const {
  FEATURE_PLANS,
  FEATURE_STATES,
  FEATURE_KEYS,
  PLAN_PRESETS,
} = require('../shared/constants/features.constants');
const { AI_PLANS } = require('../shared/constants/ai.constants');

const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE   = args.includes('--force');
const PLAN_ARG = (args.find((a) => a.startsWith('--plan=')) || '').split('=')[1];

const REASON = 'Grandfathered by scripts/migrate-entitlement.js — module in use before the entitlement system';

/**
 * Target tier for one campus. The AI grid and the module grid share the same
 * vocabulary by decision D-D, so an existing `aiEntitlement.plan` IS the tier —
 * one commercial grid, never two. `--plan=` overrides it for a bulk decision.
 *
 * @param {Object} campus
 * @returns {string} one of FEATURE_PLANS
 */
const targetPlan = (campus) => {
  if (PLAN_ARG) return PLAN_ARG;
  const aiPlan = campus?.aiEntitlement?.plan;
  return Object.values(FEATURE_PLANS).includes(aiPlan) ? aiPlan : FEATURE_PLANS.FREE;
};

/**
 * Builds the entitlement object for one campus.
 *
 * @param {Object} campus - Raw campus document.
 * @param {Date}   now
 * @returns {Object} the value to store.
 */
const buildEntitlement = (campus, now) => {
  const plan    = targetPlan(campus);
  const granted = PLAN_PRESETS[plan] || [];
  const legacy  = campus.features || {};
  const ai      = campus.aiEntitlement || {};

  const modules = FEATURE_KEYS
    .filter((key) => !granted.includes(key))
    .map((key) => ({
      key,
      state:   FEATURE_STATES.ENABLED,
      until:   null,
      reason:  REASON,
      setBy:   'admin',
      setAt:   now,
      setById: null,
    }));

  const quotas = {};
  if (legacy.maxStudents          !== undefined) quotas.maxStudents          = legacy.maxStudents;
  if (legacy.maxTeachers          !== undefined) quotas.maxTeachers          = legacy.maxTeachers;
  if (legacy.maxClasses           !== undefined) quotas.maxClasses           = legacy.maxClasses;
  if (legacy.maxDocumentStorageMB !== undefined) quotas.maxDocumentStorageMB = legacy.maxDocumentStorageMB;
  // 0 = unlimited on both sides, so the value carries over verbatim.
  if (ai.monthlyTokenBudget       !== undefined) quotas.aiMonthlyTokens      = ai.monthlyTokenBudget;

  return {
    plan,
    modules,
    quotas,
    ai: { llmProfile: ai.llmProfile || 'free' },
  };
};

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB:', mongoose.connection.name);
  console.log(DRY_RUN ? 'MODE: dry-run — no write will be performed.\n' : 'MODE: write\n');

  const campuses = mongoose.connection.db.collection('campuses');
  const cursor = campuses.find(
    {},
    { projection: { campus_name: 1, entitlement: 1, features: 1, aiEntitlement: 1 } }
  );

  const now = new Date();
  let migrated = 0;
  let skipped  = 0;
  let rebuilt  = 0;

  for await (const campus of cursor) {
    const already = Boolean(campus.entitlement);
    if (already && !FORCE) {
      skipped += 1;
      console.log(`  skip     ${campus.campus_name} — already carries an entitlement`);
      continue;
    }

    const next = buildEntitlement(campus, now);
    const label = `${campus.campus_name} → plan=${next.plan}, ${next.modules.length} grandfathered module(s)`;

    if (already) {
      console.log(`  REBUILD  ${label}`);
      console.log(`           discarding ${(campus.entitlement.modules || []).length} existing override(s)`);
      rebuilt += 1;
    } else {
      console.log(`  migrate  ${label}`);
      migrated += 1;
    }

    if (!DRY_RUN) {
      await campuses.updateOne(
        { _id: campus._id },
        {
          $set: { entitlement: next },
          // The audit trail starts with the migration itself: the first thing
          // an operator asks about an override is who put it there.
          $push: {
            entitlementAudit: {
              at: now,
              actorId: null,
              actorRole: 'SYSTEM',
              changes: { migration: 'migrate-entitlement', plan: next.plan, grandfathered: next.modules.map((m) => m.key) },
            },
          },
        }
      );
    }
  }

  console.log(`\nMigrated: ${migrated} · Rebuilt: ${rebuilt} · Skipped: ${skipped}`);
  if (DRY_RUN) console.log('Nothing was written (--dry-run).');
  // Sanity line — the AI grid and the module grid must stay one vocabulary (D-D).
  if (!Object.values(FEATURE_PLANS).includes(AI_PLANS.PREMIUM)) {
    console.warn('WARNING: AI_PLANS and FEATURE_PLANS have diverged — check decision D-D.');
  }

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
