'use strict';

/**
 * @file migrate-ged-to-object-store.js
 * @description Copies existing GED files from the local filesystem to the object store (B8-①).
 *
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * The storage service now dispatches to Cloudinary in production. Nothing about
 * that swap moves the bytes already sitting on a disk: after the deploy, every
 * document created before it points at an object that was never uploaded, and
 * downloading it returns a 404. Mongo needs no migration — a key is still
 * `{campusId}/{category}/{fileName}` — so this script only copies bytes.
 *
 * WHAT IS RECOVERABLE, AND WHAT IS NOT — the point of this script is to be blunt
 * about the difference rather than to report a clean success.
 *
 *   • A file present under UPLOAD_DIR — RECOVERABLE, uploaded under the same key.
 *
 *   • A file the database references but the disk no longer has — NOT
 *     RECOVERABLE, and the likely majority. That is the whole substance of B8-①:
 *     the production filesystem is ephemeral, so every deploy since the GED went
 *     live has already destroyed whatever had been uploaded since the previous
 *     one. These rows are COUNTED and LISTED. Nothing is written for them and no
 *     record is "repaired" — a document row pointing at a missing object is
 *     honest; one pointing at a placeholder is not.
 *
 * Run it from a host that can see BOTH the old volume (UPLOAD_DIR) and the
 * Cloudinary credentials. On a platform whose filesystem is already ephemeral,
 * expect the missing count to dominate — that is the finding, not a script fault.
 *
 * USAGE
 *   node scripts/migrate-ged-to-object-store.js            # dry run (default)
 *   node scripts/migrate-ged-to-object-store.js --apply    # upload
 */

require('dotenv').config();

const mongoose = require('mongoose');

// The backends are addressed directly and deliberately: this script must read from
// ONE side and write to the OTHER, in a single process. Going through the storage
// service would give it whichever single backend the environment resolves to.
const localBackend      = require('../modules/document/services/document.storage.local');
const cloudinaryBackend = require('../modules/document/services/document.storage.cloudinary');
const { isCloudinaryConfigured } = require('../shared/utils/storage-provider');

const APPLY = process.argv.includes('--apply');

/** Batch size for the document cursor — bounded memory over an arbitrarily large GED. */
const BATCH_SIZE = 200;

/**
 * Every object a document row claims to own, as `{ key, source }` pairs.
 *
 * Mirrors `document.service.collectOwnedFiles`, and for the same reason: the row is
 * the only thing that maps a file on disk back to a document.
 *
 * @param {object} doc  lean document
 * @returns {Array<{ key: string, source: string }>}
 */
const ownedKeys = (doc) => {
  const campusId = doc.campusId?.toString();
  if (!campusId) return [];

  const keys = [];
  const add  = (category, fileName, source) => {
    if (fileName) keys.push({ key: `${campusId}/${category}/${fileName}`, source });
  };

  add('imported', doc.importedFile?.fileName, 'importedFile');
  add('pdf',      doc.pdfSnapshot,            'pdfSnapshot');
  add('qrcodes',  doc.qrCode?.fileName,       'qrCode');

  return keys;
};

/**
 * Copies one object, unless it is already there.
 *
 * @param {{ key: string }} entry
 * @param {object} report  mutated counters
 * @returns {Promise<void>}
 */
const migrateOne = async ({ key, source }, report) => {
  const buffer = await localBackend.get(key);

  if (!buffer) {
    report.missing.push({ key, source });
    return;
  }

  const existing = await cloudinaryBackend.head(key);
  if (existing) {
    report.alreadyPresent += 1;
    return;
  }

  if (!APPLY) {
    report.wouldUpload += 1;
    report.wouldUploadBytes += buffer.length;
    return;
  }

  try {
    await cloudinaryBackend.put(key, buffer);
    report.uploaded += 1;
    report.uploadedBytes += buffer.length;
  } catch (err) {
    report.failed.push({ key, source, error: err.message });
  }
};

/**
 * Streams every document and every version snapshot, and copies what it finds.
 *
 * @returns {Promise<object>} the report
 */
const run = async () => {
  if (!isCloudinaryConfigured()) {
    console.error('❌ Cloudinary is not configured — set CLOUDINARY_CLOUD_NAME, '
      + 'CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET before running this.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const Document        = require('../modules/document/models/document.model');
  const DocumentVersion = require('../modules/document/models/document.version.model');

  const report = {
    documentsScanned: 0,
    versionsScanned:  0,
    alreadyPresent:   0,
    wouldUpload:      0,
    wouldUploadBytes: 0,
    uploaded:         0,
    uploadedBytes:    0,
    missing:          [],
    failed:           [],
  };

  console.log(`\n${APPLY ? '🚚 APPLY' : '🔍 DRY RUN'} — GED → object store`);
  console.log(`   Reading from : ${localBackend.BASE_UPLOAD_DIR}`);
  console.log(`   Writing to   : ${cloudinaryBackend.FOLDER_ROOT}/ (Cloudinary, raw/authenticated)\n`);

  const docCursor = Document
    .find({}, 'campusId importedFile.fileName pdfSnapshot qrCode.fileName')
    .lean()
    .cursor({ batchSize: BATCH_SIZE });

  for await (const doc of docCursor) {
    report.documentsScanned += 1;
    for (const entry of ownedKeys(doc)) {
      await migrateOne(entry, report);
    }
  }

  // Version snapshots are separate rows, and each one owns its own PDF. Skipping
  // them would silently drop the entire document history.
  const versionCursor = DocumentVersion
    .find({ pdfSnapshot: { $ne: null } }, 'campusId pdfSnapshot')
    .lean()
    .cursor({ batchSize: BATCH_SIZE });

  for await (const version of versionCursor) {
    report.versionsScanned += 1;
    const campusId = version.campusId?.toString();
    if (!campusId) continue;
    await migrateOne(
      { key: `${campusId}/pdf/${version.pdfSnapshot}`, source: 'version.pdfSnapshot' },
      report,
    );
  }

  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

  console.log('── Report ──────────────────────────────────────────────');
  console.log(`   Documents scanned      : ${report.documentsScanned}`);
  console.log(`   Version snapshots      : ${report.versionsScanned}`);
  console.log(`   Already in object store: ${report.alreadyPresent}`);
  if (APPLY) {
    console.log(`   Uploaded               : ${report.uploaded} (${mb(report.uploadedBytes)} MB)`);
  } else {
    console.log(`   Would upload           : ${report.wouldUpload} (${mb(report.wouldUploadBytes)} MB)`);
  }
  console.log(`   MISSING on disk        : ${report.missing.length}`);
  console.log(`   Failed                 : ${report.failed.length}`);

  if (report.missing.length) {
    console.log('\n⚠️  These objects are referenced by a record but absent from the disk.');
    console.log('   They were destroyed by an earlier deploy and cannot be recovered here.');
    console.log('   Nothing was written for them — the records are left pointing at nothing,');
    console.log('   which is the truth.\n');
    for (const { key, source } of report.missing.slice(0, 50)) {
      console.log(`     ${source.padEnd(20)} ${key}`);
    }
    if (report.missing.length > 50) {
      console.log(`     … and ${report.missing.length - 50} more`);
    }
  }

  if (report.failed.length) {
    console.log('\n❌ Upload failures:');
    for (const { key, error } of report.failed) console.log(`     ${key} — ${error}`);
  }

  if (!APPLY) {
    console.log('\n   Dry run — nothing was written. Re-run with --apply to upload.\n');
  }

  await mongoose.connection.close();
  return report;
};

if (require.main === module) {
  run().catch(async (err) => {
    console.error('❌ Migration failed:', err);
    await mongoose.connection.close().catch(() => {});
    process.exit(1);
  });
}

module.exports = { ownedKeys, migrateOne };
