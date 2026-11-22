'use strict';

/** @file audit-journal.journey.js @description Real rollback, retry, retention and immutable-byte proof on an owned replica set. */
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startEphemeralDatabase } = require('./seed');
const { assertTestDatabaseUri } = require('./seed.config');
const { service, constants: { ERROR } } = require('../../modules/audit');
const AuditEvent = require('../../modules/audit/models/audit-event.model');
const StudentFee = require('../../modules/finance/models/studentFee.model');
const { source, metadata, eventRecord } = require('../helpers/audit-journal-records');
const { prepareAuditJournal } = require('../../scripts/prepare-audit-journal');
const { REGISTRY, resolveRelationModel } = require('../../shared/lib/hard-delete/hard-delete.registry');
const { RELATION_MODE } = require('../../shared/lib/hard-delete/hard-delete.constants');

/** Allocate only a guarded disposable database; never consume an environment database URI. */
async function main() {
  assertTestDatabaseUri('mongodb://127.0.0.1/erp_test_audit_journal');
  const handle = await startEphemeralDatabase();
  let passed = 0;
  const record = label => { passed += 1; console.log(`PASS ${label}`); };
  try {
    assertTestDatabaseUri(handle.uri);
    await mongoose.connect(handle.uri, { autoIndex: false, autoCreate: false });
    const dryRun = await prepareAuditJournal();
    assert.equal(dryRun.planned.length, 5);
    assert.equal((await mongoose.connection.db.listCollections({ name: AuditEvent.collection.name }).toArray()).length, 0);
    record('index inspection does not create the journal namespace');
    await prepareAuditJournal({ apply: true });
    assert.deepEqual((await prepareAuditJournal({ apply: true })).planned, []);
    record('index preparation adds five non-expiring indexes and is idempotent');

    await StudentFee.createCollection();
    const campus = new mongoose.Types.ObjectId();
    const fee = await StudentFee.create({ student: new mongoose.Types.ObjectId(), schoolCampus: campus, amountDue: 100, label: 'Synthetic obligation' });
    const mutation = service.createMutation(source, metadata({ entityId: fee._id, schoolCampus: campus }));
    const session = await mongoose.startSession();
    let target;
    /** Couple a synthetic real business write to its projected event in one transaction. */
    const write = async (amount, context = mutation) => {
      const before = await StudentFee.findById(fee._id).session(session).lean();
      await StudentFee.updateOne({ _id: fee._id }, { $inc: { amountPaid: amount } }, { session });
      const after = await StudentFee.findById(fee._id).session(session).lean();
      return service.appendMutation(context, { before: { amountPaid: before.amountPaid }, after: { amountPaid: after.amountPaid }, session });
    };
    try {
      await assert.rejects(service.appendMutation(mutation, { before: {}, after: { amountPaid: 1 } }), error => error.code === ERROR.TRANSACTION_REQUIRED);
      record('writer refuses missing or inactive transactions');

      await session.withTransaction(async () => { target = await write(20); });
      assert.equal((await StudentFee.findById(fee._id).lean()).amountPaid, 20);
      assert.equal(await AuditEvent.countDocuments({ mutationId: target.mutationId }), 1);
      record('real business change and event commit together');

      const duplicateBefore = await AuditEvent.collection.findOne({ _id: target._id });
      await assert.rejects(session.withTransaction(async () => write(15)), error => error.code === 11000);
      assert.equal((await StudentFee.findById(fee._id).lean()).amountPaid, 20);
      assert.deepEqual(await AuditEvent.collection.findOne({ _id: target._id }), duplicateBefore);
      record('duplicate logical mutation aborts business write; no duplicate suppression');

      const retry = service.createMutation(source, metadata({ entityId: fee._id, schoolCampus: campus }));
      const abort = new Error('Synthetic abort after append');
      let aborted;
      await assert.rejects(session.withTransaction(async () => { aborted = await write(10, retry); throw abort; }), error => error === abort);
      assert.equal(await AuditEvent.countDocuments({ mutationId: aborted.mutationId }), 0);
      assert.equal((await StudentFee.findById(fee._id).lean()).amountPaid, 20);
      record('abort removes both the changed balance and its inserted event');
      let retried;
      await session.withTransaction(async () => { retried = await write(10, retry); });
      assert.equal(retried.mutationId, aborted.mutationId);
      assert.equal(retried.operationId, aborted.operationId);
      assert.deepEqual(retried.occurredAt, aborted.occurredAt);
      assert.equal(await AuditEvent.countDocuments({ mutationId: retried.mutationId }), 1);
      record('aborted transaction retry commits once with stable logical identity');

      const unchangedCount = await AuditEvent.countDocuments({});
      await session.withTransaction(async () => {
        assert.equal(await service.appendMutation(retry, { before: { amountPaid: 30 }, after: { amountPaid: 30 }, session }), null);
      });
      assert.equal(await AuditEvent.countDocuments({}), unchangedCount);
      record('normalized no-op produces no event');

      const invalid = service.createMutation(source, metadata({ entityId: fee._id, schoolCampus: campus }));
      await assert.rejects(session.withTransaction(async () => {
        await StudentFee.updateOne({ _id: fee._id }, { $inc: { amountPaid: 5 } }, { session });
        await service.appendMutation(invalid, { before: { amountPaid: 30 }, after: { amountPaid: '35' }, session });
      }), error => error.code === ERROR.INVALID_EVENT);
      assert.equal((await StudentFee.findById(fee._id).lean()).amountPaid, 30);
      record('invalid event projection rolls back the business mutation');

      const automaticRetry = service.createMutation(source, metadata({ entityId: fee._id, schoolCampus: campus }));
      let attempts = 0;
      const attemptedIds = [];
      await session.withTransaction(async () => {
        const appended = await write(1, automaticRetry);
        attemptedIds.push(appended.mutationId);
        attempts += 1;
        if (attempts === 1) {
          const transient = new mongoose.mongo.MongoServerError({ message: 'Synthetic transient transaction error' });
          transient.addErrorLabel('TransientTransactionError');
          throw transient;
        }
      });
      assert.equal(attempts, 2);
      assert.equal(attemptedIds[0], attemptedIds[1]);
      assert.equal(await AuditEvent.countDocuments({ mutationId: attemptedIds[0] }), 1);
      assert.equal((await StudentFee.findById(fee._id).lean()).amountPaid, 31);
      record('driver automatically retries a transient failure with one committed balance change/event');
    } finally { await session.endSession(); }

    const original = await AuditEvent.collection.findOne({ _id: target._id });
    const probe = eventRecord();
    const operations = [
      ['save', async () => { const doc = await AuditEvent.findById(target._id); doc.reason = 'Changed'; return doc.save(); }],
      ['save without validation', async () => { const doc = await AuditEvent.findById(target._id); doc.reason = 'Changed'; return doc.save({ validateBeforeSave: false }); }],
      ['document update', async () => (await AuditEvent.findById(target._id)).updateOne({ reason: 'Changed' })],
      ['updateOne', () => AuditEvent.updateOne({ _id: target._id }, { reason: 'Changed' })],
      ['updateMany', () => AuditEvent.updateMany({}, { reason: 'Changed' })],
      ['findByIdAndUpdate', () => AuditEvent.findByIdAndUpdate(target._id, { reason: 'Changed' })],
      ['replaceOne', () => AuditEvent.replaceOne({ _id: target._id }, eventRecord())],
      ['findOneAndReplace', () => AuditEvent.findOneAndReplace({ _id: target._id }, eventRecord())],
      ['deleteOne', () => AuditEvent.deleteOne({ _id: target._id })],
      ['deleteMany', () => AuditEvent.deleteMany({})],
      ['findByIdAndDelete', () => AuditEvent.findByIdAndDelete(target._id)],
      ['document delete', async () => (await AuditEvent.findById(target._id)).deleteOne()],
      ['$merge', () => AuditEvent.aggregate([{ $match: {} }, { $merge: 'audit_events' }])],
      ['$out', () => AuditEvent.aggregate([{ $match: {} }, { $out: 'audit_events' }])],
      ...['updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany'].map(operation => [
        `mixed unordered ${operation}`, () => AuditEvent.bulkWrite([
          { insertOne: { document: probe } },
          { [operation]: { filter: {}, update: { $set: { reason: 'Changed' } }, replacement: eventRecord() } },
        ], { ordered: false }),
      ]),
    ];
    for (const [label, invoke] of operations) {
      await assert.rejects(invoke, error => error.code === ERROR.IMMUTABLE);
      assert.deepEqual(await AuditEvent.collection.findOne({ _id: target._id }), original);
      assert.equal(await AuditEvent.countDocuments({ mutationId: probe.mutationId }), 0);
      record(`${label}: refuses with identical stored history and no partial insert`);
    }

    await AuditEvent.bulkWrite([{ insertOne: { document: eventRecord() } }]);
    await AuditEvent.insertMany([eventRecord()]);
    record('valid insert-only bulk and insertMany remain available');
    const redacted = service.createMutation(source, metadata({ schoolCampus: campus }));
    const redactionSession = await mongoose.startSession();
    let redactionEvent;
    try {
      await redactionSession.withTransaction(async () => {
        redactionEvent = await service.appendMutation(redacted, { before: { label: 'Synthetic private old' }, after: { label: 'Synthetic private new' }, session: redactionSession });
      });
    } finally { await redactionSession.endSession(); }
    assert.deepEqual((await AuditEvent.collection.findOne({ _id: redactionEvent._id })).changes, [{ field: 'label', mode: 'redacted' }]);
    record('redacted changes persist neither content nor hashes/presence flags');

    const campusRetention = REGISTRY.campus.relations.find(relation => relation.model === 'AuditEvent');
    assert.equal(campusRetention.mode, RELATION_MODE.RETAIN);
    assert.equal(await resolveRelationModel(campusRetention).countDocuments(campusRetention.filter(campus)), 4);
    for (const key of ['course', 'document', 'announcement']) {
      const relation = REGISTRY[key].relations.find(item => item.model === 'AuditEvent');
      assert.equal(relation.mode, RELATION_MODE.RETAIN);
      assert.equal(relation.filter(fee._id).entityType, REGISTRY[key].model().modelName);
    }
    record('campus and deletable sources declare retained journal references');
    console.log(`Audit journal foundation journey: ${passed}/${passed} checks passed`);
  } finally {
    try { await mongoose.disconnect(); } finally { await handle.stop(); }
  }
}

if (require.main === module) main().catch(error => { console.error(`Audit journal journey failed: ${error.message}`); process.exitCode = 1; });
module.exports = { main };
