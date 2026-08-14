'use strict';

/**
 * @file migrate-profile-image-ref.js
 * @description Backfills `profileImageRef` on rows created before it existed (B7-②/B7-③).
 *
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * `profileImage` holds a URL. A URL is a way to READ an asset, not a handle to
 * MANAGE it — which is why replacing a profile picture never deleted the old
 * one. `profileImageRef` records the storageKey a deletion actually needs, and
 * every row written before the fix is missing it.
 *
 * WHAT IS RECOVERABLE, AND WHAT IS NOT — the point of this script is to be blunt
 * about the difference rather than to report a clean success.
 *
 *   • A Cloudinary URL — RECOVERABLE. The key sits between the version segment
 *     and the extension:
 *       https://res.cloudinary.com/<cloud>/image/upload/v1712345678/backend/students/rose-9f3c2a.png
 *                                                                  └────── storageKey ──────┘
 *
 *   • An absolute local path (`/home/<someone>/…/uploads/students/…`) — NOT
 *     RECOVERABLE. It names a file on a developer's machine that was never
 *     deployed. Deriving a plausible-looking key for a file that does not exist
 *     on the server would be worse than leaving the gap: a later deletion would
 *     report `not_found` forever and nobody would know why. These rows are
 *     COUNTED and REPORTED, and `profileImage` is left untouched so the broken
 *     image stays visible instead of being silently "fixed".
 *
 * Orphaned Cloudinary assets already accumulated — uploads whose row was
 * overwritten before the fix — are not addressable from the database at all.
 * They are only listable from the Cloudinary Admin API, diffed against the keys
 * this script recovers. That is a separate, manual clean-up.
 *
 * USAGE
 *   node scripts/migrate-profile-image-ref.js            # dry run (default)
 *   node scripts/migrate-profile-image-ref.js --apply    # write
 */

require('dotenv').config();

const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

/**
 * Extracts a Cloudinary public_id from a delivery URL.
 * Returns null when the URL is not a Cloudinary delivery URL.
 *
 * @param {string} url
 * @returns {string|null}
 */
const cloudinaryKeyFromUrl = (url) => {
  const marker = '/upload/';
  const at = url.indexOf(marker);
  if (at === -1) return null;

  let rest = url.slice(at + marker.length);
  rest = rest.replace(/^v\d+\//, '');            // drop the version segment
  rest = rest.replace(/\?.*$/, '');              // drop any query string
  rest = rest.replace(/\.[a-z0-9]+$/i, '');      // drop the extension

  return rest || null;
};

/** Classifies one legacy `profileImage` value. */
const classify = (value) => {
  if (typeof value !== 'string' || !value.trim()) return { kind: 'empty' };

  if (/^https?:\/\//i.test(value)) {
    const storageKey = cloudinaryKeyFromUrl(value);
    return storageKey
      ? { kind: 'cloudinary', ref: { provider: 'cloudinary', storageKey } }
      : { kind: 'remote_unknown' };            // an https URL we did not upload
  }

  // Anything else is a filesystem path written by the development storage engine.
  return { kind: 'local_unrecoverable' };
};

const COLLECTIONS = [
  { name: 'Student', path: '../modules/student/models/student.model' },
  { name: 'Teacher', path: '../modules/teacher/models/teacher.model' },
  { name: 'Parent',  path: '../modules/parent/parent.model' },
];

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`📦 Connected to ${mongoose.connection.name}`);
  console.log(APPLY ? '✍️  APPLY mode — writes enabled' : '🔍 DRY RUN — no writes (pass --apply)');

  const totals = { cloudinary: 0, local_unrecoverable: 0, remote_unknown: 0, empty: 0 };

  for (const { name, path: modelPath } of COLLECTIONS) {
    const Model = require(modelPath);

    const rows = await Model.find(
      { profileImage: { $ne: null }, profileImageRef: null },
      { profileImage: 1 },
    ).lean();

    const counts = { cloudinary: 0, local_unrecoverable: 0, remote_unknown: 0, empty: 0 };
    const writes = [];

    for (const row of rows) {
      const outcome = classify(row.profileImage);
      counts[outcome.kind] += 1;

      if (outcome.kind === 'cloudinary') {
        writes.push({
          updateOne: { filter: { _id: row._id }, update: { $set: { profileImageRef: outcome.ref } } },
        });
      }
    }

    if (APPLY && writes.length > 0) {
      await Model.bulkWrite(writes, { ordered: false });
    }

    console.log(
      `\n${name}: ${rows.length} row(s) without a reference\n` +
      `  ✅ recovered (cloudinary)   : ${counts.cloudinary}${APPLY ? ' — written' : ''}\n` +
      `  ❌ unrecoverable (local path): ${counts.local_unrecoverable}\n` +
      `  ⚠️  remote, not cloudinary   : ${counts.remote_unknown}\n` +
      `  ·  empty / blank             : ${counts.empty}`,
    );

    for (const key of Object.keys(totals)) totals[key] += counts[key];
  }

  console.log(
    `\n── Totals ──\n` +
    `  recovered      : ${totals.cloudinary}\n` +
    `  unrecoverable  : ${totals.local_unrecoverable}  ← these keep a broken image on purpose\n` +
    `  remote unknown : ${totals.remote_unknown}\n`,
  );

  if (totals.local_unrecoverable > 0) {
    console.warn(
      '⚠️  Unrecoverable rows point at files on a developer machine. Their profileImage is left\n' +
      '   untouched so the breakage stays visible. Re-uploading is the only fix.',
    );
  }

  await mongoose.connection.close();
};

// Only connect and write when invoked directly — the classifiers are unit-tested.
if (require.main === module) {
  run().catch(async (err) => {
    console.error('❌ Migration failed:', err);
    await mongoose.connection.close().catch(() => {});
    process.exit(1);
  });
}

module.exports = { cloudinaryKeyFromUrl, classify };
