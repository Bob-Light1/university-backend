'use strict';

/**
 * @file scripts/migrate-account-activation.js
 * @description One-shot, idempotent migration of LEGACY accounts that still carry
 *              a hard-coded default password (created before the account-activation
 *              security work — see CHANTIER_ACTIVATION_COMPTES.md, Point 1).
 *
 *   For every account across the 5 user collections whose stored password STILL
 *   matches a known default, this script:
 *     1. flips status → 'pending'  (login is already blocked for non-active),
 *     2. replaces the password with an unusable random placeholder,
 *     3. issues an activation token (link + offline code) via the account service,
 *     4. exports the link + code so an admin can deliver them.
 *
 *   Detection is by `bcrypt.compare` against the known defaults — accounts whose
 *   owner already chose a password never match and are left untouched. This makes
 *   the script inherently safe and safe to re-run (already-migrated `pending`
 *   accounts are skipped).
 *
 * SAFETY:
 *   - DRY-RUN by default. Nothing is written without the `--apply` flag.
 *   - Accounts holding an elevated/global role (ADMIN · DIRECTOR · CAMPUS_MANAGER)
 *     are NEVER migrated, even if their password matches a default.
 *   - TAKE A DATABASE BACKUP before running with --apply.
 *
 * USAGE:
 *   node scripts/migrate-account-activation.js                 # dry-run (report only)
 *   node scripts/migrate-account-activation.js --apply         # perform the migration
 *   node scripts/migrate-account-activation.js --models=Student,Teacher --apply
 *   MIGRATION_EXPORT=/secure/path.csv node scripts/migrate-account-activation.js --apply
 *
 * The export CSV (link + code per account) is SENSITIVE — store it securely and
 * delete it once the codes have been distributed.
 */

require('dotenv').config();
const crypto   = require('crypto');
const bcrypt   = require('bcrypt');
const fs       = require('fs');
const path     = require('path');
const mongoose = require('mongoose');

// Register the 5 user models so mongoose.model(name) resolves inside the service.
require('../modules/mentor/mentor.model');
require('../modules/staff/models/staff.model');
require('../modules/student/models/student.model');
require('../modules/teacher/models/teacher.model');
require('../modules/parent/parent.model');

const accountService = require('../modules/account').service;

const SALT_ROUNDS = 12;

/** Elevated roles that must never be locked out by this migration. */
const PROTECTED_ROLES = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];

/**
 * Known historical default passwords per collection. `Default@123` was the
 * generic fallback used by the bulk importer, so it is a candidate everywhere.
 */
const DEFAULTS_BY_MODEL = {
  Mentor:  ['Mentor@123', 'Default@123'],
  Staff:   ['Staff@123', 'Default@123'],
  Student: ['Student@123', 'Default@123'],
  Teacher: ['Teacher@123T789', 'Default@123'],
  Parent:  ['Default@123'],
};

const args        = process.argv.slice(2);
const APPLY       = args.includes('--apply');
const modelsArg   = (args.find((a) => a.startsWith('--models=')) || '').split('=')[1];
const TARGET_MODELS = modelsArg
  ? modelsArg.split(',').map((s) => s.trim()).filter((s) => DEFAULTS_BY_MODEL[s])
  : Object.keys(DEFAULTS_BY_MODEL);

const EXPORT_PATH = process.env.MIGRATION_EXPORT
  || path.join(process.cwd(), `account-activation-export-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);

/** CSV-escapes a single field. */
const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/** True if the account carries an elevated/global role (string or array form). */
function hasProtectedRole(account) {
  const single = account.role ? [account.role] : [];
  const many   = Array.isArray(account.roles) ? account.roles : [];
  return [...single, ...many].some((r) => PROTECTED_ROLES.includes(r));
}

/** Returns the first known default that matches the stored hash, or null. */
async function matchedDefault(plainHash, candidates) {
  if (!plainHash) return null;
  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await bcrypt.compare(candidate, plainHash)) return candidate;
  }
  return null;
}

async function run() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set.');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to MongoDB: ${mongoose.connection.name}`);
  console.log(`Mode: ${APPLY ? 'APPLY (writes enabled)' : 'DRY-RUN (no writes)'}`);
  console.log(`Models: ${TARGET_MODELS.join(', ')}\n`);

  const rows = [];
  const totals = { scanned: 0, protectedSkipped: 0, nonActiveSkipped: 0, notDefault: 0, migrated: 0, failed: 0 };

  for (const modelName of TARGET_MODELS) {
    const Model = mongoose.model(modelName);
    const candidates = DEFAULTS_BY_MODEL[modelName];

    // password is `select:false` — request it explicitly.
    const accounts = await Model.find({})
      .select('+password username email matricule firstName status role roles schoolCampus preferredLanguage')
      .lean();

    let migrated = 0;
    for (const account of accounts) {
      totals.scanned += 1;

      if (account.status !== 'active') { totals.nonActiveSkipped += 1; continue; }
      if (hasProtectedRole(account))   { totals.protectedSkipped += 1; continue; }

      const hit = await matchedDefault(account.password, candidates);
      if (!hit) { totals.notDefault += 1; continue; }

      const identifier = account.username || account.email || account.matricule || '';

      if (!APPLY) {
        rows.push({ model: modelName, id: account._id, identifier, email: account.email || '', code: '(dry-run)', activationUrl: '(dry-run)', expiresAt: '' });
        totals.migrated += 1; migrated += 1;
        continue;
      }

      try {
        // Lock the account first: status → pending + unusable placeholder password.
        // updateOne bypasses the pre-save hooks (mirrors account.service writes).
        const placeholder = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), SALT_ROUNDS);
        await Model.updateOne({ _id: account._id }, { $set: { status: 'pending', password: placeholder } });

        const { activationUrl, code, expiresAt } = await accountService.issueActivationToken({
          userModel: modelName,
          userId:    account._id,
          campusId:  account.schoolCampus || null,
          email:     account.email || null,
          name:      account.firstName || '',
          locale:    account.preferredLanguage || undefined,
          createdBy: null,
        });

        rows.push({ model: modelName, id: account._id, identifier, email: account.email || '', code, activationUrl, expiresAt: expiresAt.toISOString() });
        totals.migrated += 1; migrated += 1;
      } catch (err) {
        totals.failed += 1;
        console.error(`  ✗ ${modelName} ${account._id} (${identifier}): ${err.message}`);
      }
    }
    console.log(`${modelName.padEnd(8)} → ${migrated} ${APPLY ? 'migrated' : 'would migrate'} (of ${accounts.length} scanned)`);
  }

  // Export the activation links + codes (always written when there are rows).
  if (rows.length) {
    const header = 'model,id,identifier,email,code,activationUrl,expiresAt';
    const body   = rows.map((r) => [r.model, r.id, r.identifier, r.email, r.code, r.activationUrl, r.expiresAt].map(csv).join(','));
    fs.writeFileSync(EXPORT_PATH, `${header}\n${body.join('\n')}\n`, 'utf8');
    console.log(`\nExport written: ${EXPORT_PATH}  (${rows.length} row(s)) — SENSITIVE, secure & delete after distribution.`);
  }

  console.log('\n── Summary ───────────────────────────────');
  console.log(`  Scanned:            ${totals.scanned}`);
  console.log(`  Migrated:           ${totals.migrated}${APPLY ? '' : ' (dry-run)'}`);
  console.log(`  Skipped (protected):${String(totals.protectedSkipped).padStart(4)}  (elevated role)`);
  console.log(`  Skipped (non-active):${String(totals.nonActiveSkipped).padStart(3)}  (already pending / inactive / …)`);
  console.log(`  Left (non-default): ${totals.notDefault}  (owner-chosen password)`);
  if (totals.failed) console.log(`  FAILED:             ${totals.failed}`);
  if (!APPLY) console.log('\n  DRY-RUN — re-run with --apply to perform the migration (after a DB backup).');

  await mongoose.disconnect();
  console.log('\nDone.');
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
