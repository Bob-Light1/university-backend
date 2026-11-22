'use strict';

/** @file announcement.audit.test.js @description Persisted eligibility, explicit projections, retry and transactional workflow regressions. */
jest.mock('../../modules/announcement/announcement.repository', () => ({
  withTransaction: jest.fn(), loadForMutation: jest.fn(), saveMutation: jest.fn(), listDue: jest.fn(), loadDue: jest.fn(),
}));
jest.mock('../../modules/audit/audit.repository', () => ({ requireTransaction: jest.fn(), append: jest.fn(async event => event) }));
const mongoose = require('mongoose');
const Announcement = require('../../modules/announcement/models/announcement.model');
const repository = require('../../modules/announcement/announcement.repository');
const journal = require('../../modules/audit/audit.repository');
const mutations = require('../../modules/announcement/announcement.mutation.service');
const { project, FIELDS, EXCLUDED_FIELDS } = require('../../modules/announcement/announcement.audit');
const { STATUS, OPERATION, SWEEP_PAGE_SIZE } = require('../../modules/announcement/announcement.constants');
const { constants: { ACTOR, MODE } } = require('../../modules/audit');
const { softDeletePatch } = require('../../shared/utils/soft-delete');
const user = { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', role: 'CAMPUS_MANAGER', campusId: 'bbbbbbbbbbbbbbbbbbbbbbbb' };
const session = {};
/** Construct a normalized synthetic model with all real schema defaults. */
function document(fields = {}) { return new Announcement({ schoolCampus: user.campusId, title: 'Synthetic title', content: 'Synthetic content', ...fields }); }
beforeEach(() => {
  jest.clearAllMocks(); repository.withTransaction.mockImplementation(callback => callback(session));
  repository.saveMutation.mockImplementation(async doc => doc.toObject());
});

test('every schema field is explicitly projected or excluded', () => {
  const projected = Object.keys(FIELDS).map(field => field.startsWith('targetRole_') ? 'targetRoles' : field);
  expect(Object.keys(Announcement.schema.paths).filter(path => ![...projected, ...EXCLUDED_FIELDS].includes(path))).toEqual([]);
});

test('first publication marks eligibility without an event; forged fields cannot clear it', async () => {
  const doc = document(); repository.loadForMutation.mockResolvedValue(doc);
  await mutations.publishAnnouncement(doc.id, user);
  expect(doc.auditEligible).toBe(true); expect(doc.status).toBe(STATUS.PUBLISHED); expect(journal.append).not.toHaveBeenCalled();
});

test('archived published content retains eligibility and redacts title/content', async () => {
  const doc = document({ status: STATUS.ARCHIVED, publishedAt: new Date('2026-01-01'), auditEligible: false });
  repository.loadForMutation.mockResolvedValue(doc);
  await mutations.updateAnnouncement(doc.id, user, { title: 'Changed private title', content: 'Changed private body', auditEligible: false, schoolCampus: new mongoose.Types.ObjectId(), publishedAt: null });
  expect(doc.auditEligible).toBe(true); expect(String(doc.schoolCampus)).toBe(user.campusId); expect(doc.publishedAt).not.toBeNull();
  const event = journal.append.mock.calls[0][0];
  expect(event.changes).toEqual([{ field: 'title', mode: MODE.REDACTED }, { field: 'content', mode: MODE.REDACTED }]);
  expect(JSON.stringify(event)).not.toContain('Changed private');
  expect(String(event.schoolCampus)).toBe(user.campusId); expect(String(event.actor.id)).toBe(user.id); expect(event.actor.role).toBe(user.role);
});

test('sticky marker covers legacy state without publication timestamp', async () => {
  const doc = document({ status: STATUS.ARCHIVED, auditEligible: true }); repository.loadForMutation.mockResolvedValue(doc);
  await mutations.togglePin(doc.id, user, {}); expect(journal.append).toHaveBeenCalledTimes(1);
});

test.each([STATUS.DRAFT, STATUS.ARCHIVED])('unpublished %s edits remain ineligible', async status => {
  const doc = document({ status }); repository.loadForMutation.mockResolvedValue(doc);
  await mutations.updateAnnouncement(doc.id, user, { title: 'New draft title', auditEligible: true });
  expect(doc.auditEligible).toBe(false); expect(journal.append).not.toHaveBeenCalled();
});

test('publishing an already published record is refused without a write or event', async () => {
  const doc = document({ status: STATUS.PUBLISHED }); repository.loadForMutation.mockResolvedValue(doc);
  await expect(mutations.publishAnnouncement(doc.id, user)).rejects.toMatchObject({ statusCode: 400 });
  expect(repository.saveMutation).not.toHaveBeenCalled(); expect(journal.append).not.toHaveBeenCalled();
});

test('published edit guard uses the state loaded inside the transaction', async () => {
  const doc = document({ status: STATUS.PUBLISHED }); repository.loadForMutation.mockResolvedValue(doc);
  await expect(mutations.updateAnnouncement(doc.id, user, { title: 'Refused' })).rejects.toMatchObject({ statusCode: 400 });
  expect(repository.saveMutation).not.toHaveBeenCalled();
});

test('expired publication is refused without a write', async () => {
  const doc = document({ expiresAt: new Date('2000-01-01') }); repository.loadForMutation.mockResolvedValue(doc);
  await expect(mutations.publishAnnouncement(doc.id, user)).rejects.toMatchObject({ statusCode: 400 }); expect(repository.saveMutation).not.toHaveBeenCalled();
});

test('republishing an eligible archive emits the actual state transition', async () => {
  const doc = document({ status: STATUS.ARCHIVED, auditEligible: true }); repository.loadForMutation.mockResolvedValue(doc);
  await mutations.publishAnnouncement(doc.id, user);
  expect(journal.append.mock.calls[0][0].changes).toContainEqual(expect.objectContaining({ field: 'status', before: STATUS.ARCHIVED, after: STATUS.PUBLISHED }));
});

test('normalized no-op emits nothing', async () => {
  const doc = document({ status: STATUS.ARCHIVED, auditEligible: true }); repository.loadForMutation.mockResolvedValue(doc);
  await mutations.updateAnnouncement(doc.id, user, { title: ` ${doc.title} ` }); expect(journal.append).not.toHaveBeenCalled();
});

test('typed role memberships, dates and type changes survive projection', async () => {
  const doc = document({ status: STATUS.ARCHIVED, auditEligible: true }); repository.loadForMutation.mockResolvedValue(doc);
  const until = '2099-12-01T09:00:00.000Z';
  await mutations.updateAnnouncement(doc.id, user, { type: 'urgent', targetRoles: ['STUDENT'], pinned: true, pinnedUntil: until, expiresAt: until });
  const changes = journal.append.mock.calls[0][0].changes;
  expect(changes).toContainEqual(expect.objectContaining({ field: 'targetRole_ALL', before: true, after: false }));
  expect(changes).toContainEqual(expect.objectContaining({ field: 'targetRole_STUDENT', before: false, after: true }));
  expect(changes).toContainEqual(expect.objectContaining({ field: 'pinnedUntil', before: null, after: new Date(until) }));
  expect(changes).toContainEqual(expect.objectContaining({ field: 'type', before: 'info', after: 'urgent' }));
});

test('soft deletion derives the marker and keeps publication status', async () => {
  const doc = document({ status: STATUS.PUBLISHED }); repository.loadForMutation.mockResolvedValue(doc);
  await mutations.deleteAnnouncement(doc.id, user);
  expect(doc.status).toBe(STATUS.PUBLISHED); expect(doc.deletedAt).toBeInstanceOf(Date);
  expect(journal.append.mock.calls[0][0].changes.map(change => change.field)).toEqual(Object.keys(softDeletePatch(Announcement)));
});

test('transaction retry reuses identity but reads state again', async () => {
  const id = new mongoose.Types.ObjectId();
  repository.loadForMutation.mockImplementation(async () => document({ _id: id, status: STATUS.PUBLISHED }));
  repository.withTransaction.mockImplementation(async callback => { await callback(session); return callback(session); });
  await mutations.togglePin(String(id), user, {});
  const [first, second] = journal.append.mock.calls.map(([event]) => event);
  expect(second.mutationId).toBe(first.mutationId); expect(second.operationId).toBe(first.operationId);
  expect(repository.loadForMutation).toHaveBeenCalledTimes(2); expect(repository.saveMutation).toHaveBeenCalledTimes(2);
});

test('event failure propagates to the transaction owner', async () => {
  const doc = document({ status: STATUS.PUBLISHED }); repository.loadForMutation.mockResolvedValue(doc);
  const error = new Error('Synthetic event rejection'); journal.append.mockRejectedValueOnce(error);
  await expect(mutations.archiveAnnouncement(doc.id, user)).rejects.toBe(error);
});

test('out-of-scope or deleted lookup produces no write/event', async () => {
  repository.loadForMutation.mockResolvedValue(null);
  await expect(mutations.togglePin(user.id, user, {})).resolves.toBeNull(); expect(repository.saveMutation).not.toHaveBeenCalled();
});

test.each(['invalid', '2000-01-01'])('invalid future date %s is refused before saving', async pinnedUntil => {
  const doc = document({ status: STATUS.PUBLISHED }); repository.loadForMutation.mockResolvedValue(doc);
  await expect(mutations.togglePin(doc.id, user, { pinnedUntil })).rejects.toMatchObject({ statusCode: 400 });
  expect(repository.saveMutation).not.toHaveBeenCalled();
});

test('sweep reads bounded pages, rechecks each candidate, counts only committed rows', async () => {
  const first = document({ status: STATUS.PUBLISHED }); const skipped = document();
  repository.listDue.mockResolvedValueOnce([{ _id: first._id }, { _id: skipped._id }]).mockResolvedValueOnce([]);
  repository.loadDue.mockResolvedValueOnce(first).mockResolvedValueOnce(null);
  const now = new Date('2026-11-20');
  await expect(mutations.archiveExpired(now)).resolves.toBe(1);
  expect(repository.listDue).toHaveBeenNthCalledWith(2, OPERATION.EXPIRE, now, { afterId: skipped._id, limit: SWEEP_PAGE_SIZE });
  expect(repository.loadDue).toHaveBeenCalledWith(first._id, OPERATION.EXPIRE, now, session);
  expect(journal.append.mock.calls[0][0].actor).toEqual({ kind: ACTOR.SYSTEM, id: null, role: null, source: OPERATION.EXPIRE });
});

test('sweep error retains prior committed count', async () => {
  const first = document({ status: STATUS.PUBLISHED }); const second = document({ status: STATUS.PUBLISHED });
  repository.listDue.mockResolvedValueOnce([{ _id: first._id }, { _id: second._id }]);
  repository.loadDue.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  journal.append.mockImplementationOnce(async event => event).mockRejectedValueOnce(new Error('Synthetic later failure'));
  await expect(mutations.archiveExpired(new Date())).rejects.toMatchObject({ committedCount: 1, operation: OPERATION.EXPIRE });
});

test('draft-only automatic unpin is not an event', async () => {
  const doc = document({ pinned: true }); repository.listDue.mockResolvedValueOnce([{ _id: doc._id }]).mockResolvedValueOnce([]);
  repository.loadDue.mockResolvedValue(doc); await expect(mutations.unpinExpired(new Date())).resolves.toBe(1);
  expect(journal.append).not.toHaveBeenCalled(); expect(doc.pinned).toBe(false);
});

test('projection excludes delivery and audit bookkeeping', () => {
  const state = project(document({ auditEligible: true }).toObject());
  for (const field of EXCLUDED_FIELDS) expect(state).not.toHaveProperty(field);
});
