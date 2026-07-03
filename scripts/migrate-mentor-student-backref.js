'use strict';

/**
 * @file scripts/migrate-mentor-student-backref.js
 * @description One-shot, idempotent migration that makes `Student.mentor` the
 *   SINGLE SOURCE OF TRUTH for the mentor↔student link.
 *
 *   Historically the relation was stored twice: as `Mentor.students[]` (an array
 *   of ObjectIds on the mentor) AND as `Student.mentor` (a scalar), kept in sync
 *   by best-effort application code that could diverge. The mentor module now
 *   derives its roster from `Student.mentor` (virtual populate) and no longer
 *   stores `students[]`.
 *
 *   This script rebuilds `Student.mentor` from every legacy `Mentor.students[]`
 *   array so no assignment is lost, then (optionally) drops the now-dead stored
 *   array from the mentor documents.
 *
 *   Because the Mongoose schema no longer declares `Mentor.students`, the legacy
 *   array is invisible through the model — so we read the RAW documents via the
 *   native driver (`collection('mentors')`).
 *
 * SAFETY:
 *   - DRY-RUN by default. Nothing is written without `--apply`.
 *   - Each student is (re)assigned only within its OWN campus (schoolCampus must
 *     match the mentor's) — cross-campus rows in a legacy array are skipped.
 *   - The stored `students[]` array is only removed when BOTH `--apply` and
 *     `--cleanup` are passed, so you can verify the rebuild first.
 *   - Idempotent: re-running sets the same values and reports 0 remaining diffs.
 *   - TAKE A DATABASE BACKUP before running with --apply.
 *
 * USAGE:
 *   node scripts/migrate-mentor-student-backref.js                    # dry-run report
 *   node scripts/migrate-mentor-student-backref.js --apply            # rebuild Student.mentor
 *   node scripts/migrate-mentor-student-backref.js --apply --cleanup  # + $unset Mentor.students
 */

require('dotenv').config();
const mongoose = require('mongoose');

// Register the models used (Student.updateMany goes through the model).
require('../modules/mentor/mentor.model');
const Student = require('../modules/student/models/student.model');

const args    = process.argv.slice(2);
const APPLY   = args.includes('--apply');
const CLEANUP = args.includes('--cleanup');

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set.');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to MongoDB: ${mongoose.connection.name}`);
  console.log(APPLY ? '⚙️  APPLY mode — writes enabled.' : '🔍 DRY-RUN — no writes. Pass --apply to persist.');

  const mentorsCol = mongoose.connection.db.collection('mentors');

  // Legacy mentors that still carry a non-empty stored students[] array.
  const legacyMentors = await mentorsCol
    .find({ students: { $exists: true, $type: 'array', $ne: [] } })
    .project({ _id: 1, schoolCampus: 1, students: 1, firstName: 1, lastName: 1 })
    .toArray();

  console.log(`\nMentors with a legacy students[] array: ${legacyMentors.length}`);

  let totalAssigned  = 0; // Student.mentor rows written (or that would be written)
  let totalConflicts = 0; // students listed under >1 mentor
  const seenStudent  = new Map(); // studentId -> mentorId (first writer wins in the report)

  for (const mentor of legacyMentors) {
    const studentIds = (mentor.students || []).map((id) => id?.toString()).filter(Boolean);
    if (!studentIds.length) continue;

    // Detect students already claimed by another mentor earlier in this run.
    for (const sid of studentIds) {
      if (seenStudent.has(sid) && seenStudent.get(sid) !== mentor._id.toString()) {
        totalConflicts += 1;
        console.warn(
          `  ⚠️  student ${sid} appears under multiple mentors ` +
          `(${seenStudent.get(sid)} and ${mentor._id}). Last-in-iteration wins.`
        );
      } else if (!seenStudent.has(sid)) {
        seenStudent.set(sid, mentor._id.toString());
      }
    }

    if (APPLY) {
      // Campus-scoped: never move a student to a mentor from another campus.
      const r = await Student.updateMany(
        { _id: { $in: mentor.students }, schoolCampus: mentor.schoolCampus },
        { $set: { mentor: mentor._id } }
      );
      totalAssigned += r.modifiedCount;
    } else {
      const wouldMatch = await Student.countDocuments({
        _id: { $in: mentor.students },
        schoolCampus: mentor.schoolCampus,
        mentor: { $ne: mentor._id },
      });
      totalAssigned += wouldMatch;
    }
  }

  console.log(`\n${APPLY ? 'Assigned' : 'Would assign'} Student.mentor rows: ${totalAssigned}`);
  console.log(`Cross-mentor conflicts detected: ${totalConflicts}`);

  if (CLEANUP) {
    if (APPLY) {
      const r = await mentorsCol.updateMany(
        { students: { $exists: true } },
        { $unset: { students: '' } }
      );
      console.log(`\n🧹 Removed the dead students[] array from ${r.modifiedCount} mentor document(s).`);
    } else {
      console.log('\n🧹 --cleanup requested but ignored in dry-run (needs --apply).');
    }
  } else {
    console.log('\nℹ️  Stored Mentor.students[] left in place. Re-run with --apply --cleanup to $unset it.');
  }

  console.log('\nDone.');
}

main()
  .catch((err) => { console.error('❌ Migration failed:', err); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
