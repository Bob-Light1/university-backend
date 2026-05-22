'use strict';

/**
 * One-time migration: Subject.isActive → status field
 *
 * Run once after deploying the status-normalization patch.
 *   node scripts/migrate-subject-status.js
 *
 * Safe to run multiple times — each filter targets only documents
 * that still carry the old isActive field.
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB:', mongoose.connection.name);

  const collection = mongoose.connection.db.collection('subjects');

  // isActive: false → status: 'archived'
  const archived = await collection.updateMany(
    { isActive: false },
    { $set: { status: 'archived' }, $unset: { isActive: '' } },
  );
  console.log(`Archived: ${archived.modifiedCount} subject(s) → status='archived'`);

  // isActive: true → status: 'active'
  const activated = await collection.updateMany(
    { isActive: true },
    { $set: { status: 'active' }, $unset: { isActive: '' } },
  );
  console.log(`Active:   ${activated.modifiedCount} subject(s) → status='active'`);

  // Documents without any status field (isActive never set) → default to 'active'
  const defaulted = await collection.updateMany(
    { status: { $exists: false } },
    { $set: { status: 'active' } },
  );
  console.log(`Defaulted: ${defaulted.modifiedCount} subject(s) had no status → status='active'`);

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
