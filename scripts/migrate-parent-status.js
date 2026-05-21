'use strict';

/**
 * One-time migration: Parent.isArchived → status = 'archived'
 *
 * Run once after deploying the status-normalization patch.
 *   node scripts/migrate-parent-status.js
 *
 * Safe to run multiple times — the filter only targets documents
 * that still carry the old `isArchived: true` field.
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB:', mongoose.connection.name);

  const db = mongoose.connection.db;
  const collection = db.collection('parents');

  // Mark formerly-archived parents with the new status field
  const archived = await collection.updateMany(
    { isArchived: true },
    { $set: { status: 'archived' }, $unset: { isArchived: '' } },
  );
  console.log(`Archived: ${archived.modifiedCount} parent(s) updated → status='archived'`);

  // Remove the leftover isArchived field from all other parents (clean-up)
  const cleaned = await collection.updateMany(
    { isArchived: { $exists: true } },
    { $unset: { isArchived: '' } },
  );
  console.log(`Cleaned:  ${cleaned.modifiedCount} parent(s) had residual isArchived field removed`);

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
