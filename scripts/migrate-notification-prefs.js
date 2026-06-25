'use strict';

/**
 * @file scripts/migrate-notification-prefs.js
 * @description One-shot, idempotent migration of the `notificationPrefs` sub-document
 *              from the LEGACY decorative shape `{ email, sms, push }` to the channel-
 *              aligned shape `{ inapp, email, whatsapp }` actually honoured by the
 *              notification foundation (see notification.service.notify — Point B audit).
 *
 *   Mapping (per user account, across the 6 user collections):
 *     inapp    ← true            (baseline inbox — always on, not user-disableable)
 *     email    ← prefs.email     (preserved; defaults to true when absent)
 *     whatsapp ← prefs.sms       (the SMS toggle was the only mobile intent; remapped)
 *     push                       → dropped (never had a real delivery channel)
 *
 *   Because the Mongoose sub-schema no longer declares `sms`/`push`, those legacy
 *   fields are invisible through the models — so this script reads and rewrites the
 *   RAW documents via the native driver (`Model.collection`).
 *
 * SAFETY:
 *   - DRY-RUN by default. Nothing is written without the `--apply` flag.
 *   - Idempotent: documents already in the new shape (no `sms`/`push`, `inapp` present)
 *     are skipped. Safe to re-run.
 *   - TAKE A DATABASE BACKUP before running with --apply.
 *
 * USAGE:
 *   node scripts/migrate-notification-prefs.js                         # dry-run (report only)
 *   node scripts/migrate-notification-prefs.js --apply                 # perform the migration
 *   node scripts/migrate-notification-prefs.js --models=Student,Parent # restrict to some models
 *   node scripts/migrate-notification-prefs.js --models=Student --apply
 */

require('dotenv').config();
const mongoose = require('mongoose');

const MODELS = {
  Student: require('../modules/student/models/student.model'),
  Teacher: require('../modules/teacher/models/teacher.model'),
  Parent:  require('../modules/parent/parent.model'),
  Mentor:  require('../modules/mentor/mentor.model'),
  Staff:   require('../modules/staff/models/staff.model'),
  Admin:   require('../modules/admin/admin.model'),
};

const args  = process.argv.slice(2);
const APPLY = args.includes('--apply');
const only  = (args.find((a) => a.startsWith('--models=')) || '').split('=')[1];
const SELECTED = only ? only.split(',').map((s) => s.trim()).filter(Boolean) : Object.keys(MODELS);

// A document needs migration when it still carries a legacy field, or has not yet
// gained the `inapp` baseline flag. A doc with no `notificationPrefs` at all is left
// untouched (the model default applies on its next save).
const NEEDS_MIGRATION = {
  notificationPrefs: { $exists: true },
  $or: [
    { 'notificationPrefs.sms':   { $exists: true } },
    { 'notificationPrefs.push':  { $exists: true } },
    { 'notificationPrefs.inapp': { $exists: false } },
  ],
};

/** Builds the new prefs object from a legacy (raw) one. */
const toNewShape = (legacy = {}) => ({
  inapp:    true,
  email:    legacy.email !== false, // preserve opt-out; default true
  whatsapp: legacy.sms === true,    // the old SMS intent becomes WhatsApp; default false
});

async function migrateModel(name) {
  const col = MODELS[name].collection;
  const cursor = col.find(NEEDS_MIGRATION, { projection: { notificationPrefs: 1 } });

  let scanned = 0;
  let updated = 0;
  const ops = [];

  for await (const doc of cursor) {
    scanned += 1;
    const next = toNewShape(doc.notificationPrefs);
    if (APPLY) {
      ops.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { notificationPrefs: next } },
        },
      });
      if (ops.length === 500) { await col.bulkWrite(ops); ops.length = 0; }
    }
    updated += 1;
  }
  if (APPLY && ops.length) await col.bulkWrite(ops);

  console.log(`  ${name.padEnd(8)} : ${scanned} legacy doc(s) ${APPLY ? `→ ${updated} migrated` : 'to migrate'}`);
  return { scanned, updated };
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set.');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to MongoDB: ${mongoose.connection.name}`);
  console.log(APPLY ? '── APPLY mode — writing changes ──' : '── DRY-RUN — no writes (pass --apply to migrate) ──');
  console.log(`Models: ${SELECTED.join(', ')}\n`);

  let totalScanned = 0;
  let totalUpdated = 0;
  for (const name of SELECTED) {
    if (!MODELS[name]) { console.warn(`  (skipped unknown model '${name}')`); continue; }
    const { scanned, updated } = await migrateModel(name);
    totalScanned += scanned;
    totalUpdated += updated;
  }

  console.log(`\nDone. ${totalScanned} legacy document(s) ${APPLY ? `migrated (${totalUpdated} written)` : 'would be migrated'}.`);
  if (!APPLY && totalScanned > 0) console.log('Re-run with --apply to perform the migration.');
}

main()
  .catch((err) => { console.error('Migration failed:', err); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
