'use strict';

/** @file admission.repository.test.js @description Campus/lead ownership, revision matching and retained-byte query contracts. */
jest.mock('../../modules/partner/models/partner.lead.model', () => ({
  findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn(),
}));
jest.mock('../../modules/partner/models/admission.attachment.model', () => ({
  modelName: 'AdmissionAttachment',
  schema: require('../helpers/soft-delete-stub').softDeleteSchemaStub(['deletedAt', 'deletedBy']),
  find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), aggregate: jest.fn(), create: jest.fn(),
}));
const Lead = require('../../modules/partner/models/partner.lead.model');
const Attachment = require('../../modules/partner/models/admission.attachment.model');
const repo = require('../../modules/partner/admission.repository');
const { notDeletedFilter, softDeletePatch } = require('../../shared/utils/soft-delete');
const lead = { _id: 'lead-a', schoolCampus: 'campus-a', status: 'contacted' };
const session = { synthetic: true };
const query = () => {
  const q = {};
  for (const method of ['select', 'sort', 'session']) q[method] = jest.fn(() => q);
  q.lean = jest.fn().mockResolvedValue([]);
  return q;
};
beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-10-23T00:00:00Z') });
  jest.clearAllMocks();
  for (const model of [Lead, Attachment]) for (const method of ['find', 'findOne', 'findOneAndUpdate', 'aggregate']) {
    if (model[method]) model[method].mockImplementation(query);
  }
});
afterEach(() => jest.useRealTimers());

test('private lists derive deletion and ownership filters and exclude storage keys', async () => {
  await repo.listAttachments(lead, { session });
  expect(Attachment.find).toHaveBeenCalledWith({ lead: lead._id, schoolCampus: lead.schoolCampus, ...notDeletedFilter(Attachment) });
  expect(Attachment.find.mock.results[0].value.select).toHaveBeenCalledWith('-fileName');
  expect(Attachment.find.mock.results[0].value.session).toHaveBeenCalledWith(session);
});

test('a file id never replaces lead and campus ownership', async () => {
  await repo.findAttachment('file-b', lead, { session });
  expect(Attachment.findOne).toHaveBeenCalledWith({ _id: 'file-b', lead: lead._id, schoolCampus: lead.schoolCampus, ...notDeletedFilter(Attachment) });
  expect(Attachment.findOne.mock.results[0].value.select).toHaveBeenCalledWith('+fileName');
});

test('archive patches are derived and retain file metadata', async () => {
  await repo.archiveAttachment('file-a', lead, 'actor-a', session);
  const [filter, update, options] = Attachment.findOneAndUpdate.mock.calls[0];
  expect(filter).toEqual({ _id: 'file-a', lead: lead._id, schoolCampus: lead.schoolCampus, ...notDeletedFilter(Attachment) });
  expect(update).toEqual({ $set: { ...softDeletePatch(Attachment), deletedBy: 'actor-a' } });
  expect(options.session).toBe(session);
});

test('each mutation matches its prior status, campus and optimistic revision', async () => {
  await repo.mutateLead(lead, 4, { status: 'dossier_submitted' }, null, session);
  expect(Lead.findOneAndUpdate).toHaveBeenCalledWith({
    _id: lead._id, schoolCampus: lead.schoolCampus, status: lead.status, 'dossier.revision': 4,
  }, { $set: { status: 'dossier_submitted' }, $inc: { 'dossier.revision': 1 } }, { new: true, runValidators: true, session });
});

test('legacy absent revision is zero and never matches a newer dossier', async () => {
  await repo.mutateLead(lead, 0, {}, null, session);
  expect(Lead.findOneAndUpdate.mock.calls[0][0].$or).toEqual([
    { 'dossier.revision': 0 }, { 'dossier.revision': { $exists: false } },
  ]);
});

test('capabilities require an unexpired hash and exclude closed dossiers', async () => {
  await repo.findCapability('synthetic-hash');
  expect(Lead.findOne).toHaveBeenCalledWith({
    dossierAccessHash: 'synthetic-hash', dossierAccessExpiresAt: { $gt: expect.any(Date) },
    honeypotTripped: false, status: { $nin: ['rejected', 'abandoned'] },
  });
});
