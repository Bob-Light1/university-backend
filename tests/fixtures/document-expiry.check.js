'use strict';

/**
 * @file document-expiry.check.js
 * @description Prove targeted index retirement and business-data survival under actual TTL passes.
 * Uses only an owned disposable server; never reads a caller database URI or runs the seed.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
if (process.env.NODE_ENV === 'production') throw new Error('Document expiry check refuses production mode.');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
const Document = require('../../modules/document/models/document.model');
const { DOCUMENT_TYPE, DOCUMENT_CATEGORY, DOCUMENT_STATUS } = Document;
const DocumentShare = require('../../modules/document/models/document.share.model');
const { AUDIT_ACTION } = require('../../modules/document/models/document.audit.model');
const { softDeletePatch } = require('../../shared/utils/soft-delete');
const { retireDocumentExpiry } = require('../../scripts/retire-document-expiry');
let checks = 0;

/** Record only assertions that have succeeded. */
function check(label, condition) {
  assert.ok(condition, label);
  checks++;
  console.log(`  PASS ${label}`);
}

/** Run a bounded real-mongod acceptance with monitoring enabled only on this owned server. */
async function main() {
  const server = await MongoMemoryServer.create({ instance: {
    dbName: 'erp_test_document_expiry',
    args: ['--setParameter', 'ttlMonitorEnabled=false', '--setParameter', 'ttlMonitorSleepSecs=1'],
  } });
  const cliDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-expiry-cli-'));
  try {
    const uri = server.getUri('erp_test_document_expiry');
    await mongoose.connect(uri);
    // An empty owned cwd excludes any application .env. The CLI must use this URI.
    const runCli = async (...args) => JSON.parse((await execFile(process.execPath,
      [path.resolve(__dirname, '../../scripts/retire-document-expiry.js'), ...args], {
        cwd: cliDirectory, env: { ...process.env, MONGODB_URI: uri }, timeout: 30000,
      })).stdout);
    const db = mongoose.connection.db;
    const documents = Document.collection;
    await Document.createCollection();
    await Document.createIndexes();
    await DocumentShare.createCollection();
    await DocumentShare.createIndexes();
    check('new business collections contain no TTL index',
      !(await documents.listIndexes().toArray()).some(index => index.expireAfterSeconds !== undefined));

    const campusId = new mongoose.Types.ObjectId();
    const actorId = new mongoose.Types.ObjectId();
    const live = await Document.create({
      ref: 'DOC-EXPIRY-LIVE', title: 'Synthetic expiry regression',
      type: DOCUMENT_TYPE.CUSTOM, category: DOCUMENT_CATEGORY.ADMINISTRATIVE,
      campusId, status: DOCUMENT_STATUS.PUBLISHED,
      createdBy: { userId: actorId, userModel: 'Admin' }, expiresAt: new Date(0),
      importedFile: { fileName: 'synthetic-attachment.pdf', sizeBytes: 12 },
      pdfSnapshot: 'synthetic-snapshot.pdf', qrCode: { fileName: 'synthetic-qr.png' },
    });
    check('model creates discard unsupported expiry dates',
      !Object.hasOwn(await documents.findOne({ _id: live._id }), 'expiresAt'));
    await Document.updateOne({ _id: live._id }, { $set: { title: 'Synthetic updated document', expiresAt: new Date(0) } });
    check('model updates persist valid content while discarding expiry dates',
      (await documents.findOne({ _id: live._id })).title === 'Synthetic updated document'
      && !Object.hasOwn(await documents.findOne({ _id: live._id }), 'expiresAt'));

    // Materialize a legacy installation while TTL is disabled on the owned server.
    await documents.createIndex({ expiresAt: 1 }, { name: 'legacy_custom_expiry', expireAfterSeconds: 0 });
    await documents.createIndex({ title: 1 }, { name: 'unrelated_title_lookup' });
    await documents.updateOne({ _id: live._id }, { $set: { expiresAt: new Date(0) } });
    const archived = { ...(await documents.findOne({ _id: live._id })),
      _id: new mongoose.Types.ObjectId(), ref: 'DOC-EXPIRY-TRASH', slug: 'expiry-trash', ...softDeletePatch(Document) };
    await documents.insertOne(archived);
    const versions = db.collection('documentversions');
    const audits = db.collection('documentaudits');
    const shares = DocumentShare.collection;
    await versions.insertOne({ documentId: live._id, campusId, pdfSnapshot: 'synthetic-version.pdf' });
    await audits.insertOne({ documentId: live._id, campusId, action: AUDIT_ACTION.CREATE, reason: 'Synthetic test record' });
    const activeShare = { _id: new mongoose.Types.ObjectId(), documentId: live._id, campusId,
      tokenHash: 'synthetic-active-capability-hash', expiresAt: new Date(Date.now() + 3600000) };
    await shares.insertOne(activeShare);
    const before = await documents.find({}).sort({ _id: 1 }).toArray();
    const beforeVersions = await versions.find({}).toArray();
    const beforeAudits = await audits.find({}).toArray();
    const indexesBefore = await documents.listIndexes().toArray();
    const dryRun = await retireDocumentExpiry();
    assert.deepEqual(await runCli(), dryRun);
    check('dry run discovers a custom-named installed TTL index',
      !dryRun.apply && dryRun.planned.length === 1 && dryRun.planned[0] === 'legacy_custom_expiry');
    assert.deepEqual(await documents.listIndexes().toArray(), indexesBefore);
    check('dry run leaves installed indexes unchanged', true);
    const applied = await runCli('--apply');
    check('apply removes only the discovered legacy TTL index', applied.dropped.length === 1
      && applied.dropped[0] === 'legacy_custom_expiry');
    assert.deepEqual(await documents.listIndexes().toArray(),
      indexesBefore.filter(index => index.name !== 'legacy_custom_expiry'));
    check('identity, search, uniqueness and unrelated indexes survive', true);
    const replay = await retireDocumentExpiry({ apply: true });
    check('apply replay is a no-op', replay.planned.length === 0 && replay.dropped.length === 0);
    assert.deepEqual(await documents.find({}).sort({ _id: 1 }).toArray(), before);
    assert.deepEqual(await versions.find({}).toArray(), beforeVersions);
    assert.deepEqual(await audits.find({}).toArray(), beforeAudits);
    assert.deepEqual(await shares.find({}).toArray(), [activeShare]);
    check('migration preserves business rows, historical dates and all related records byte for byte', true);

    const expiredShareId = new mongoose.Types.ObjectId();
    await shares.insertOne({ _id: expiredShareId, documentId: live._id, campusId,
      tokenHash: 'synthetic-expired-capability-hash', expiresAt: new Date(0) });
    const passesBefore = (await db.admin().command({ serverStatus: 1 })).metrics.ttl.passes;
    await db.admin().command({ setParameter: 1, ttlMonitorEnabled: true });
    const deadline = Date.now() + 15000;
    let passes = passesBefore;
    while (Date.now() < deadline) {
      passes = (await db.admin().command({ serverStatus: 1 })).metrics.ttl.passes;
      if (passes >= passesBefore + 2 && !(await shares.findOne({ _id: expiredShareId }))) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    check('at least two real TTL passes occurred', passes >= passesBefore + 2);
    check('expired share capability is still automatically removed', !(await shares.findOne({ _id: expiredShareId })));
    assert.deepEqual(await documents.find({}).sort({ _id: 1 }).toArray(), before);
    assert.deepEqual(await versions.find({}).toArray(), beforeVersions);
    assert.deepEqual(await audits.find({}).toArray(), beforeAudits);
    assert.deepEqual(await shares.find({}).toArray(), [activeShare]);
    check('expired live/trash business documents, file references, versions and audit survive active TTL', true);
    console.log(`Document expiry acceptance: ${checks}/${checks} PASS`);
  } finally {
    await mongoose.disconnect();
    await server.stop();
    fs.rmSync(cliDirectory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
