'use strict';

/** @file audit-journal.test.js @description Projection, transaction, model guard and index preparation contracts. */
const mongoose = require('mongoose');
const { service, constants } = require('../../modules/audit');
const repository = require('../../modules/audit/audit.repository');
const { projectChanges } = require('../../modules/audit/audit.projection');
const { validateEvent } = require('../../modules/audit/audit.validation');
const AuditEvent = require('../../modules/audit/models/audit-event.model');
const { source, metadata, eventRecord } = require('../helpers/audit-journal-records');
const { prepareAuditJournal } = require('../../scripts/prepare-audit-journal');
const { ERROR, TYPE, SCOPE } = constants;

afterEach(() => jest.restoreAllMocks());

describe('journal projections and retry identities', () => {
  test('normalizes IDs/dates, preserves absence/null and discards redacted values', () => {
    const id = new mongoose.Types.ObjectId();
    const date = new Date('2026-01-01T00:00:00Z');
    expect(projectChanges(source, { student: id, dueDate: date }, { student: id.toString(), dueDate: new Date(date) })).toEqual([]);
    const changes = projectChanges(source, { label: 'Synthetic old text' }, { label: 'Synthetic new text', dueDate: null });
    expect(changes).toEqual([
      { field: 'label', mode: 'redacted' },
      { field: 'dueDate', mode: 'value', hasBefore: false, hasAfter: true, after: null },
    ]);
    expect(JSON.stringify(changes)).not.toContain('Synthetic');
    expect(projectChanges(source, { dueDate: null }, {})).toEqual([
      { field: 'dueDate', mode: 'value', hasBefore: true, hasAfter: false, before: null },
    ]);
  });

  test.each([
    { token: 'Synthetic-private-value' }, { amountPaid: '20' }, { amountPaid: NaN },
    { amountPaid: Infinity }, { dueDate: '2026-01-01' }, { student: {} },
    { isDeleted: 'false' }, { status: 'unknown' }, { amountPaid: undefined },
  ])('rejects unknown or untyped projected state %#', after => {
    expect(() => projectChanges(source, {}, after)).toThrow(ERROR.INVALID_EVENT);
  });

  test('source declarations are detached and opaque', () => {
    const fields = { total: { type: TYPE.NUMBER } };
    const operations = ['update'];
    const declared = service.defineSource({ entityType: 'Income', operations, fields });
    fields.total.type = TYPE.REDACTED;
    operations.push('rogue');
    expect(() => projectChanges(declared, {}, { total: 'private' })).toThrow(ERROR.INVALID_EVENT);
    expect(() => service.createMutation(declared, metadata({ operation: 'rogue' }))).toThrow(ERROR.INVALID_EVENT);
    expect(() => service.createMutation({ entityType: 'StudentFee' }, metadata())).toThrow(ERROR.INVALID_EVENT);
    expect(() => service.createMutation(source, metadata(), {})).toThrow(ERROR.INVALID_EVENT);
  });

  test.each([
    { schoolCampus: null }, { scope: SCOPE.GLOBAL, schoolCampus: null },
    { actor: { kind: 'anonymous', id: new mongoose.Types.ObjectId(), role: 'PARENT', source: 'recordPayment' } },
    { actor: { kind: 'user', id: new mongoose.Types.ObjectId(), role: 'unknown', source: 'recordPayment' } },
    { actor: { kind: 'system', id: null, role: null, source: 'unverified' } },
    { operation: '/untrusted/url' }, { partnerId: new mongoose.Types.ObjectId() },
    { reason: 'x'.repeat(constants.LIMIT.REASON + 1) }, { mutationId: 'caller-supplied' },
    { related: [{ entityType: 'Student', entityId: new mongoose.Types.ObjectId(), token: 'private' }] },
  ])('refuses invalid scope or provenance %#', input => {
    expect(() => service.createMutation(source, metadata(input))).toThrow(/AUDIT_(INVALID_EVENT|SCOPE_REQUIRED)/);
  });

  test('only explicitly global sources permit null campus', () => {
    const global = service.defineSource({ entityType: 'Course', operations: ['archive'], fields: { isLatestVersion: { type: TYPE.BOOLEAN } } });
    expect(() => service.createMutation(global, metadata({ scope: SCOPE.GLOBAL, schoolCampus: null, operation: 'archive', actor: { kind: 'system', id: null, role: null, source: 'archive' } }))).not.toThrow();
    expect(() => service.createMutation(global, metadata({ operation: 'archive' }))).toThrow(ERROR.SCOPE_REQUIRED);
  });

  test.each([undefined, {}, { inTransaction: () => false }])('requires a transaction even for no-ops %#', async session => {
    const append = jest.spyOn(repository, 'append');
    const mutation = service.createMutation(source, metadata());
    await expect(service.appendMutation(mutation, { before: {}, after: {}, session })).rejects.toHaveProperty('code', ERROR.TRANSACTION_REQUIRED);
    expect(append).not.toHaveBeenCalled();
  });

  test('retries reuse identity, recompute changes and propagate insertion failure', async () => {
    const append = jest.spyOn(repository, 'append').mockImplementation(async event => event);
    const client = new mongoose.mongo.MongoClient('mongodb://127.0.0.1/erp_test_audit_journal');
    const session = client.startSession();
    session.startTransaction();
    jest.spyOn(AuditEvent.db, 'getClient').mockReturnValue(client);
    const data = metadata();
    const operation = service.createOperation();
    const mutation = service.createMutation(source, data, operation);
    data.actor.role = 'TEACHER';
    const first = await service.appendMutation(mutation, { before: { amountPaid: 0 }, after: { amountPaid: 20 }, session });
    const retry = await service.appendMutation(mutation, { before: { amountPaid: 10 }, after: { amountPaid: 30 }, session });
    expect(retry.mutationId).toBe(first.mutationId);
    expect(retry.operationId).toBe(first.operationId);
    expect(retry.occurredAt).toEqual(first.occurredAt);
    expect(retry.changes[0].before).toBe(10);
    expect(retry.actor.role).toBe('ADMIN');
    const correlated = service.createMutation(source, metadata(), operation);
    const other = await service.appendMutation(correlated, { before: { amountPaid: 0 }, after: { amountPaid: 5 }, session });
    expect(other.operationId).toBe(first.operationId);
    expect(other.mutationId).not.toBe(first.mutationId);
    expect(await service.appendMutation(mutation, { before: { amountPaid: 5 }, after: { amountPaid: 5 }, session })).toBeNull();
    expect(append).toHaveBeenCalledTimes(3);
    const failure = new Error('Synthetic insertion failure');
    append.mockRejectedValueOnce(failure);
    await expect(service.appendMutation(mutation, { before: { amountPaid: 0 }, after: { amountPaid: 20 }, session })).rejects.toBe(failure);
    await session.endSession();
  });

  test('repository refuses an active session belonging to another client', async () => {
    const create = jest.spyOn(AuditEvent, 'create');
    await expect(repository.append(eventRecord(), { inTransaction: () => true, client: {} })).rejects.toHaveProperty('code', ERROR.TRANSACTION_REQUIRED);
    expect(create).not.toHaveBeenCalled();
  });

  test.each(['spoofed', 'foreign'])('a no-op still rejects a %s transaction', async kind => {
    const mutation = service.createMutation(source, metadata());
    const client = new mongoose.mongo.MongoClient('mongodb://127.0.0.1/erp_test_audit_journal');
    const session = kind === 'spoofed' ? { inTransaction: () => true } : client.startSession();
    if (kind === 'foreign') session.startTransaction();
    try {
      await expect(service.appendMutation(mutation, { before: {}, after: {}, session })).rejects.toHaveProperty('code', ERROR.TRANSACTION_REQUIRED);
    } finally { if (kind === 'foreign') await session.endSession(); }
  });
});

describe('actual immutable model middleware', () => {
  const id = new mongoose.Types.ObjectId();
  const methods = [
    ['updateOne', () => AuditEvent.updateOne({ _id: id }, { $set: { reason: 'changed' } })],
    ['updateMany', () => AuditEvent.updateMany({}, { $set: { reason: 'changed' } })],
    ['findOneAndUpdate', () => AuditEvent.findByIdAndUpdate(id, { reason: 'changed' })],
    ['replaceOne', () => AuditEvent.replaceOne({ _id: id }, eventRecord())],
    ['findOneAndReplace', () => AuditEvent.findOneAndReplace({ _id: id }, eventRecord())],
    ['updateOne', () => AuditEvent.hydrate({ _id: id }).updateOne({ reason: 'changed' })],
    ['deleteOne', () => AuditEvent.deleteOne({ _id: id })],
    ['deleteMany', () => AuditEvent.deleteMany({})],
    ['findOneAndDelete', () => AuditEvent.findByIdAndDelete(id)],
    ['deleteOne', () => AuditEvent.hydrate({ _id: id }).deleteOne()],
    ['updateOne', () => AuditEvent.hydrate({ ...eventRecord(), _id: id }).save({ validateBeforeSave: false })],
  ];
  test.each(methods)('rejects %s before the driver %#', async (method, invoke) => {
    const driver = jest.spyOn(AuditEvent.collection, method).mockResolvedValue({});
    await expect(invoke()).rejects.toHaveProperty('code', ERROR.IMMUTABLE);
    expect(driver).not.toHaveBeenCalled();
  });

  test.each(['updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany'])('rejects entire unordered bulk containing %s', async operation => {
    const driver = jest.spyOn(AuditEvent.collection, 'bulkWrite').mockResolvedValue({});
    await expect(AuditEvent.bulkWrite([
      { insertOne: { document: eventRecord() } },
      { [operation]: { filter: {}, update: { $set: { reason: 'changed' } }, replacement: eventRecord() } },
    ], { ordered: false })).rejects.toHaveProperty('code', ERROR.IMMUTABLE);
    expect(driver).not.toHaveBeenCalled();
  });

  test('model validates before casting; insert-only bulk cannot disable event validation', async () => {
    const valid = new AuditEvent(eventRecord());
    await expect(valid.validate()).resolves.toBeUndefined();
    const bad = eventRecord();
    bad.changes[0].before = { credential: 'private' };
    const driver = jest.spyOn(AuditEvent.collection, 'bulkWrite').mockResolvedValue({});
    await expect(AuditEvent.bulkWrite([{ insertOne: { document: bad } }], { skipValidation: true })).rejects.toHaveProperty('code', ERROR.INVALID_EVENT);
    expect(driver).not.toHaveBeenCalled();
    await expect(AuditEvent.insertMany([eventRecord()], { lean: true })).rejects.toHaveProperty('code', ERROR.INVALID_EVENT);
  });

  test.each(['$merge', '$out'])('rejects aggregation writes through %s', async stage => {
    const driver = jest.spyOn(AuditEvent.collection, 'aggregate').mockReturnValue({ toArray: async () => [] });
    await expect(AuditEvent.aggregate([{ $match: {} }, { [stage]: 'audit_events' }])).rejects.toHaveProperty('code', ERROR.IMMUTABLE);
    expect(driver).not.toHaveBeenCalled();
  });

  test.each([
    changes => { changes[0].hasBefore = false; },
    changes => { changes[0].after = changes[0].before; },
    changes => { changes[0].after = Infinity; },
    changes => { changes.push(changes[0]); },
    changes => { changes[0] = { field: 'label', mode: 'redacted', before: 'private' }; },
    changes => { changes.push(...Array(constants.LIMIT.CHANGES).fill({ field: 'a', mode: 'redacted' })); },
  ])('rejects invalid raw change arrays %#', mutate => {
    const data = eventRecord(); mutate(data.changes);
    expect(() => validateEvent(data)).toThrow(ERROR.INVALID_EVENT);
  });

  test('rejects unknown metadata and missing commission ownership before casting', () => {
    expect(() => validateEvent({ ...eventRecord(), privateMetadata: 'Synthetic private value' })).toThrow(ERROR.INVALID_EVENT);
    const commission = { ...eventRecord(), module: 'partner', entityType: 'PartnerCommission', source: { module: 'partner', operation: 'recordPayment' } };
    expect(() => validateEvent(commission)).toThrow(ERROR.INVALID_EVENT);
    expect(() => validateEvent({ ...commission, partnerId: new mongoose.Types.ObjectId() })).not.toThrow();
  });
});

describe('expand-only journal index preparation', () => {
  const missing = () => Object.assign(new Error('Missing namespace'), { code: 26 });
  const indexDefinitions = () => AuditEvent.schema.indexes().map(([key, opts]) => ({ key, ...opts }));
  const collection = installed => ({
    collectionName: 'audit_events',
    listIndexes: jest.fn(() => ({ toArray: async () => installed })),
    createIndexes: jest.fn(),
  });

  test('inspection creates no namespace and certifies no historical source coverage', async () => {
    const target = collection([]);
    target.listIndexes.mockImplementation(() => ({ toArray: async () => { throw missing(); } }));
    const result = await prepareAuditJournal({ collection: target });
    expect(result.planned).toHaveLength(5);
    expect(result.apply).toBe(false);
    expect(result.sourceEligibilityPrepared).toBe(false);
    expect(result.historicalCoverageCertified).toBe(false);
    expect(target.createIndexes).not.toHaveBeenCalled();
  });

  test('apply only adds missing indexes, verifies, and becomes idempotent', async () => {
    const installed = [{ name: '_id_', key: { _id: 1 } }, ...indexDefinitions().slice(0, 1)];
    const target = collection(installed);
    target.createIndexes.mockImplementation(async indexes => installed.push(...indexes));
    const result = await prepareAuditJournal({ apply: true, collection: target });
    expect(result.planned).toHaveLength(4);
    expect(target.createIndexes).toHaveBeenCalledTimes(1);
    expect((await prepareAuditJournal({ apply: true, collection: target })).planned).toEqual([]);
    expect(target.createIndexes).toHaveBeenCalledTimes(1);
  });

  test.each([
    [{ name: 'expiry', key: { occurredAt: 1 }, expireAfterSeconds: 1 }],
    [{ name: 'audit_mutation_unique', key: { mutationId: 1 } }],
    [{ name: 'audit_mutation_unique', key: { other: 1 }, unique: true }],
    [{ name: 'custom', key: { mutationId: 1 }, unique: true, sparse: true }],
    [{ name: 'custom', key: { mutationId: 1 }, unique: true, partialFilterExpression: { mutationId: { $exists: true } } }],
  ])('refuses conflicting or expiring indexes before applying %#', async index => {
    const target = collection([index]);
    await expect(prepareAuditJournal({ apply: true, collection: target })).rejects.toThrow(/Unexpected|Conflicting/);
    expect(target.createIndexes).not.toHaveBeenCalled();
  });
});
