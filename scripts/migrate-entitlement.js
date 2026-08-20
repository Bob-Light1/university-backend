'use strict';

/**
 * Folds the two legacy configuration objects of `Campus` into the unified
 * `entitlement` (CAMPUS_ENTITLEMENT_DESIGN.md §10, phase 1.2):
 *
 *   node scripts/migrate-entitlement.js [--dry-run] [--plan=<tier>] [--force]
 *
 * ── THE FOLD ITSELF IS NOT HERE ──────────────────────────────────────────────
 * It lives in `shared/lib/entitlement/entitlement.legacy.js`, because this
 * script is no longer its only caller: since phase 2 the first entitlement
 * write reaching an unmigrated campus folds the same way, so that a campus
 * touched from the admin console before this script runs does not end up with
 * a tier and no grandfathering behind it. Two implementations of "what does
 * this campus already have" would drift, and the half that drifts is the one
 * that runs once, by hand, on production data.
 *
 * Read that file for the rules — grandfathering, the `ai` exception, and why
 * only deviations are stored. This one owns the traversal, the reporting and
 * the idempotency, and nothing else.
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

const { FEATURE_PLANS } = require('../shared/constants/features.constants');
const { AI_PLANS } = require('../shared/constants/ai.constants');
const { foldLegacyEntitlement } = require('../shared/lib/entitlement/entitlement.legacy');
// Required for its collection name only — the documents are read and written
// through the raw driver, because the legacy fields this script folds away
// (`features.max*`) are being removed from the schema and `strict: true` would
// hide them. The name itself must never be a literal: Mongoose's pluralizer
// maps `Campus` to `campus`, not `campuses`, and a hard-coded name that matches
// no collection fails the way this script must never fail — an empty cursor,
// a clean exit and a report of zero campuses migrated.
const Campus = require('../modules/campus/campus.model');

const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE   = args.includes('--force');
const PLAN_ARG = (args.find((a) => a.startsWith('--plan=')) || '').split('=')[1];

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB:', mongoose.connection.name);
  console.log(DRY_RUN ? 'MODE: dry-run — no write will be performed.\n' : 'MODE: write\n');

  const campuses = mongoose.connection.db.collection(Campus.collection.collectionName);
  const total = await campuses.countDocuments();
  console.log(`Collection: ${Campus.collection.collectionName} — ${total} campus(es)\n`);
  if (total === 0) {
    // A migration that touches nothing is indistinguishable from a migration
    // that could not find its data. Say which one this is.
    console.warn('WARNING: no campus found. Check MONGODB_URI points at the right database.');
  }

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

    const next = foldLegacyEntitlement(campus, { plan: PLAN_ARG, now });
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
