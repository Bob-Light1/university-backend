'use strict';

/**
 * @file audit-retention.journey.js
 * @description Proves ledger retention and permitted writes against an owned disposable replica set.
 */

const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startEphemeralDatabase } = require('./seed');
const { assertTestDatabaseUri } = require('./seed.config');
const { auditLedgerRecord } = require('../helpers/audit-ledger-records');
const DocumentAudit = require('../../modules/document/models/document.audit.model');
const DeletionAudit = require('../../shared/lib/hard-delete/deletion-audit.model');

/**
 * Runs only against a newly owned ephemeral database; never consumes MONGODB_URI.
 *
 * @returns {Promise<void>}
 */
const main = async () => {
  // Refuse a production-mode invocation before allocating an ephemeral server.
  assertTestDatabaseUri('mongodb://127.0.0.1/erp_test_audit_retention');
  const handle = await startEphemeralDatabase();
  let passed = 0;

  /** @param {string} label Records a completed assertion group. */
  const record = (label) => {
    passed += 1;
    console.log(`PASS ${label}`);
  };

  try {
    assertTestDatabaseUri(handle.uri);
    await mongoose.connect(handle.uri, { sanitizeFilter: true });

    for (const Model of [DocumentAudit, DeletionAudit]) {
      await Model.init();
      const payload = auditLedgerRecord(Model);
      const target = await Model.create(payload);
      assert.equal(await Model.countDocuments({ _id: target._id }), 1);
      record(`${Model.modelName}: ordinary append and read`);

      const probe = auditLedgerRecord(Model, 'mixed-probe');
      const operations = [
        ['model deleteOne', () => Model.deleteOne({ _id: target._id })],
        ['model deleteMany', () => Model.deleteMany({})],
        ['findOneAndDelete', () => Model.findOneAndDelete({ _id: target._id })],
        ['findByIdAndDelete', () => Model.findByIdAndDelete(target._id)],
        ['instance deleteOne', () => target.deleteOne()],
        ['bulk deleteOne', () => Model.bulkWrite([
          { deleteOne: { filter: { _id: target._id } } },
        ])],
        ['unordered bulk deleteMany', () => Model.bulkWrite([
          { deleteMany: { filter: {} } },
        ], { ordered: false })],
        ['mixed unordered bulk', () => Model.bulkWrite([
          { insertOne: { document: probe } },
          { deleteMany: { filter: {} } },
        ], { ordered: false })],
      ];

      for (const [label, invoke] of operations) {
        const before = await Model.collection.findOne({ _id: target._id });
        await assert.rejects(invoke, new RegExp(`${Model.modelName} records are immutable`));
        const after = await Model.collection.findOne({ _id: target._id });
        assert.deepEqual(after, before, 'Refusal must retain the original stored bytes');
        assert.equal(await Model.countDocuments({ _id: probe._id }), 0, 'No partial insertion is allowed');
        record(`${Model.modelName}: ${label} refuses without changing history`);
      }

      const bulkRecord = auditLedgerRecord(Model, 'bulk-append');
      await Model.bulkWrite([{ insertOne: { document: bulkRecord } }]);
      assert.equal(await Model.countDocuments({ _id: bulkRecord._id }), 1);
      record(`${Model.modelName}: insert-only bulk still appends`);

      const session = await mongoose.startSession();
      const transactional = auditLedgerRecord(Model, 'transactional-append');
      const abort = new Error('Synthetic transaction rollback');
      try {
        await assert.rejects(session.withTransaction(async () => {
          await Model.bulkWrite([{ insertOne: { document: transactional } }], { session });
          assert.equal(await Model.countDocuments({ _id: transactional._id }).session(session), 1);
          throw abort;
        }), (error) => error === abort);
      } finally {
        await session.endSession();
      }
      assert.equal(await Model.countDocuments({ _id: transactional._id }), 0);
      record(`${Model.modelName}: bulk append preserves transaction rollback`);
    }

    const deletion = auditLedgerRecord(DeletionAudit);
    await DeletionAudit.updateOne({ _id: deletion._id }, { $set: { filesRemoved: ['synthetic-cleanup.txt'] } });
    assert.deepEqual((await DeletionAudit.findById(deletion._id).lean()).filesRemoved, ['synthetic-cleanup.txt']);
    record('DeletionAudit: existing post-cleanup enrichment remains supported');

    await assert.rejects(
      DeletionAudit.findOne({ reason: { $ne: null } }).exec(),
      mongoose.Error.CastError,
    );
    assert.equal(await DeletionAudit.countDocuments({ reason: deletion.reason }), 2);
    record('Connection-level sanitizeFilter blocks selector injection and preserves literal reads');

    console.log(`Audit retention journey: ${passed}/${passed} checks passed`);
  } finally {
    try {
      await mongoose.disconnect();
    } finally {
      await handle.stop();
    }
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`Audit retention journey failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
