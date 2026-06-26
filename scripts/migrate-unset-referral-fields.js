'use strict';

/**
 * @file scripts/migrate-unset-referral-fields.js
 * @description One-shot, idempotent cleanup of the referral refactor (Phase 1/2).
 *
 *   The Partner schema no longer stores `referralLink` (now a virtual derived from
 *   partnerCode) nor `qrCodeFileName` (the QR is generated on the fly). Documents
 *   created before the refactor still carry those stale fields. They are harmless
 *   (Mongoose ignores unknown paths on read), but they waste space and can mislead
 *   anyone inspecting the collection. This script `$unset`s both fields.
 *
 * SAFETY:
 *   - DRY-RUN by default — nothing is written without the `--apply` flag.
 *   - Idempotent: a re-run after success matches 0 documents.
 *   - Only removes the two legacy fields; no other data is touched.
 *   - TAKE A DATABASE BACKUP before running with --apply.
 *
 * USAGE:
 *   node scripts/migrate-unset-referral-fields.js            # dry-run (report only)
 *   node scripts/migrate-unset-referral-fields.js --apply    # perform the cleanup
 */

require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.slice(2).includes('--apply');

// Match docs that still carry either legacy field (strict mode ignores them on
// normal queries, so target them directly through the raw collection).
const STALE_FILTER = {
  $or: [
    { referralLink:   { $exists: true } },
    { qrCodeFileName: { $exists: true } },
  ],
};

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set.');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to MongoDB: ${mongoose.connection.name}`);

  const partners = mongoose.connection.collection('partners');
  const affected = await partners.countDocuments(STALE_FILTER);

  console.log(`Partners carrying a stale referralLink / qrCodeFileName: ${affected}`);

  if (affected === 0) {
    console.log('Nothing to clean up. ✅');
  } else if (!APPLY) {
    console.log('\n  DRY-RUN — re-run with --apply to perform the cleanup (after a DB backup).');
  } else {
    const { modifiedCount } = await partners.updateMany(
      STALE_FILTER,
      { $unset: { referralLink: '', qrCodeFileName: '' } },
    );
    console.log(`Cleaned ${modifiedCount} partner document(s). ✅`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
