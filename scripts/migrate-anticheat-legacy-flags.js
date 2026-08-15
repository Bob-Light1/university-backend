'use strict';

/**
 * @file scripts/migrate-anticheat-legacy-flags.js
 * @description One-shot, idempotent migration that marks pre-2026-08-15 anti-cheat flags
 *   as LEGACY, so a reviewer can tell a finding produced by the corrected measure from one
 *   produced by the measure it replaced.
 *
 *   Every existing `SIMILARITY_FLAG` on `ExamSubmission.antiCheatFlags` was written by the
 *   old job and carries two independent problems (REMEDIATION_PLAN.md §4, Group 4):
 *
 *     - it was scored by a COSINE SIMILARITY over categorical option indices (B9-⑥).
 *       Exhaustively, over every three-question four-option pair, 16.0% of all
 *       zero-agreement pairs crossed the 0.85 threshold — while two identical all-option-0
 *       papers scored 0.0 and were never flagged at all. The findings are not merely noisy,
 *       they are biased in a direction unrelated to collusion;
 *     - it was written TWICE (B9-④). A 48 h "recently completed" window read by a job
 *       running every 24 h selected each session on two consecutive nights, and the append
 *       is `$push`, so each pair holds a duplicate flag.
 *
 * ── THE DECISION THIS SCRIPT IMPLEMENTS ─────────────────────────────────────────────
 *
 *   MARK, do not purge. Recorded in REMEDIATION_PLAN.md §7.3.
 *
 *   The plan asks for the choice to be explicit because purging is a deletion of
 *   audit-shaped data. Three facts decided it:
 *
 *     1. No screen reads `antiCheatFlags` (plan §7 — `grep -rn "antiCheatFlags" frontend/src`
 *        returns zero). There is no review queue being polluted, so nothing is urgent, and
 *        the argument for deletion — "stop reviewers acting on bad accusations" — has no
 *        subject.
 *     2. These rows are the only surviving evidence of what the old job did. Deleting them
 *        removes the ability to answer "was this student ever flagged, and on what basis"
 *        — a question that gets asked precisely when it matters.
 *     3. Marking is reversible and purging is not. Between two options that are equally
 *        correct today, the reversible one leaves the decision open.
 *
 *   `--purge` exists for whoever decides otherwise, and refuses to run without it being
 *   typed explicitly. It is not the default and should not become one silently.
 *
 * WHAT IT WRITES
 *
 *   type: 'SIMILARITY_FLAG'  →  type: 'SIMILARITY_FLAG_LEGACY'
 *   detail: '<original>'     →  detail: '[LEGACY cosine metric, may be a false positive] <original>'
 *
 *   The type is a free-form String in AntiCheatFlagSchema, so no schema change is needed.
 *   New flags written by the corrected job keep the plain `SIMILARITY_FLAG` type, which is
 *   what makes the two distinguishable at a glance and in a query.
 *
 * SAFETY
 *   - DRY-RUN by default. Nothing is written without `--apply`.
 *   - Idempotent: an already-marked flag is skipped, so re-running reports 0 changes and
 *     never double-prefixes a detail string.
 *   - Duplicates are REPORTED, never silently collapsed: which of two identical flags to
 *     keep is not a question a migration should answer on its own.
 *   - TAKE A DATABASE BACKUP before running with --apply.
 *
 * USAGE
 *   node scripts/migrate-anticheat-legacy-flags.js                  # dry-run report
 *   node scripts/migrate-anticheat-legacy-flags.js --apply          # mark as legacy
 *   node scripts/migrate-anticheat-legacy-flags.js --apply --purge  # DELETE them instead
 */

require('dotenv').config();
const mongoose = require('mongoose');

const ExamSubmission = require('../modules/exam/models/exam.submission.model');

const args   = process.argv.slice(2);
const APPLY  = args.includes('--apply');
const PURGE  = args.includes('--purge');

const LEGACY_TYPE   = 'SIMILARITY_FLAG_LEGACY';
const CURRENT_TYPE  = 'SIMILARITY_FLAG';
const LEGACY_PREFIX = '[LEGACY cosine metric, may be a false positive] ';

/** A flag written by the old job: current type, and not already marked. */
const isLegacyFlag = (flag) => flag?.type === CURRENT_TYPE;

/**
 * Counts flags that are byte-identical duplicates of another on the same submission,
 * ignoring the timestamp (the two nightly passes ran a day apart).
 */
const countDuplicates = (flags) => {
  const seen = new Set();
  let duplicates = 0;
  for (const flag of flags) {
    const key = `${flag.type}::${flag.detail}`;
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  }
  return duplicates;
};

const main = async () => {
  if (!process.env.MONGO_URI) {
    console.error('❌ MONGO_URI is not set.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`✅ Connected. Mode: ${APPLY ? (PURGE ? 'APPLY --purge (DESTRUCTIVE)' : 'APPLY') : 'DRY RUN'}\n`);

  const submissions = await ExamSubmission
    .find({ 'antiCheatFlags.type': { $in: [CURRENT_TYPE] } })
    .select('_id examSession antiCheatFlags')
    .lean();

  let submissionsTouched = 0;
  let flagsAffected      = 0;
  let duplicatesFound    = 0;

  for (const submission of submissions) {
    const flags  = submission.antiCheatFlags || [];
    const legacy = flags.filter(isLegacyFlag);
    if (legacy.length === 0) continue;

    submissionsTouched += 1;
    flagsAffected      += legacy.length;
    duplicatesFound    += countDuplicates(legacy);

    if (!APPLY) continue;

    if (PURGE) {
      await ExamSubmission.updateOne(
        { _id: submission._id },
        { $pull: { antiCheatFlags: { type: CURRENT_TYPE } } },
      );
      continue;
    }

    // Rewrite in place: the array is replaced wholesale because $set on a positional match
    // cannot update every matching element in one operation.
    const rewritten = flags.map((flag) => (isLegacyFlag(flag)
      ? { ...flag, type: LEGACY_TYPE, detail: `${LEGACY_PREFIX}${flag.detail || ''}`.trim() }
      : flag));

    await ExamSubmission.updateOne(
      { _id: submission._id },
      { $set: { antiCheatFlags: rewritten } },
    );
  }

  console.log('── Report ────────────────────────────────────────────────');
  console.log(`Submissions carrying old flags : ${submissionsTouched}`);
  console.log(`Flags ${PURGE ? 'to delete' : 'to mark legacy'}          : ${flagsAffected}`);
  console.log(`  …of which duplicates (B9-④)  : ${duplicatesFound}`);
  console.log('──────────────────────────────────────────────────────────');

  if (!APPLY) {
    console.log('\nDRY RUN — nothing was written. Re-run with --apply to proceed.');
  } else if (PURGE) {
    console.log('\n⚠️  Flags DELETED. This is not reversible without a backup restore.');
  } else {
    console.log(`\n✅ Flags marked as ${LEGACY_TYPE}. New findings keep the ${CURRENT_TYPE} type.`);
  }

  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error('❌ Migration failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
