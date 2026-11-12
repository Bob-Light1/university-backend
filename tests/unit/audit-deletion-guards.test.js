'use strict';

/**
 * @file audit-deletion-guards.test.js
 * @description Real Mongoose middleware must stop ledger deletion before any driver call.
 */

const mongoose = require('mongoose');
const DocumentAudit = require('../../modules/document/models/document.audit.model');
const DeletionAudit = require('../../shared/lib/hard-delete/deletion-audit.model');
const { auditLedgerRecord } = require('../helpers/audit-ledger-records');

const target = new mongoose.Types.ObjectId();
const MODELS = [DocumentAudit, DeletionAudit];

const DELETIONS = [
  ['model deleteOne', 'deleteOne', (Model) => Model.deleteOne({ _id: target })],
  ['model deleteMany', 'deleteMany', (Model) => Model.deleteMany({ _id: target })],
  ['findOneAndDelete', 'findOneAndDelete', (Model) => Model.findOneAndDelete({ _id: target })],
  ['findByIdAndDelete', 'findOneAndDelete', (Model) => Model.findByIdAndDelete(target)],
  ['instance deleteOne', 'deleteOne', (Model) => Model.hydrate({ _id: target }).deleteOne()],
  ['ordered bulk deleteOne', 'bulkWrite', (Model) => Model.bulkWrite([
    { deleteOne: { filter: { _id: target } } },
  ])],
  ['unordered bulk deleteMany', 'bulkWrite', (Model) => Model.bulkWrite([
    { deleteMany: { filter: {} } },
  ], { ordered: false })],
  ['mixed unordered bulk', 'bulkWrite', (Model) => Model.bulkWrite([
    { insertOne: { document: auditLedgerRecord(Model, 'mixed-probe') } },
    { deleteOne: { filter: { _id: target } } },
  ], { ordered: false })],
];

afterEach(() => jest.restoreAllMocks());

describe.each(MODELS.map((Model) => [Model.modelName, Model]))('%s audit retention', (_name, Model) => {
  test.each(DELETIONS)('%s is refused before the driver', async (_label, method, invoke) => {
    const driver = jest.spyOn(Model.collection, method).mockResolvedValue({ deletedCount: 1 });
    await expect(invoke(Model)).rejects.toThrow(`${Model.modelName} records are immutable`);
    expect(driver).not.toHaveBeenCalled();
  });
});
