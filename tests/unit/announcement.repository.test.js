'use strict';

/** @file announcement.repository.test.js @description Campus/deletion filters and transactional announcement persistence contracts. */
jest.mock('../../modules/announcement/models/announcement.model', () => {
  const chain = () => {
    const query = {};
    for (const name of ['sort', 'skip', 'limit', 'select', 'session']) query[name] = jest.fn(() => query);
    query.lean = jest.fn().mockResolvedValue([]);
    query.distinct = jest.fn().mockResolvedValue([]);
    return query;
  };
  return {
    modelName: 'Announcement',
    schema: require('../helpers/soft-delete-stub').softDeleteSchemaStub(['status', 'deletedAt']),
    db: { startSession: jest.fn() },
    find: jest.fn(chain), findOne: jest.fn(chain), findById: jest.fn(chain),
    create: jest.fn(), countDocuments: jest.fn().mockResolvedValue(0),
  };
});
jest.mock('../../modules/announcement/models/user-notification.model', () => ({}));
const Announcement = require('../../modules/announcement/models/announcement.model');
const repository = require('../../modules/announcement/announcement.repository');
const { STATUS, OPERATION, SWEEP_PAGE_SIZE } = require('../../modules/announcement/announcement.constants');
const { notDeletedFilter, deletedOnlyFilter } = require('../../shared/utils/soft-delete');
const A = 'aaaaaaaaaaaaaaaaaaaaaaaa'; const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const session = { withTransaction: jest.fn(callback => callback()), endSession: jest.fn() };
beforeEach(() => { jest.clearAllMocks(); Announcement.db.startSession.mockResolvedValue(session); });

describe('management scope', () => {
  test('scoped callers cannot select another campus', async () => {
    await repository.paginateForAdmin({ isGlobalRole: false, campusId: A, requestedCampusId: B, skip: 0, limit: 20 });
    expect(Announcement.find.mock.calls[0][0]).toEqual({ ...notDeletedFilter(Announcement), schoolCampus: A });
  });
  test.each([undefined, 'invalid'])('missing or malformed campus %s fails closed', async campusId => {
    await expect(repository.paginateForAdmin({ isGlobalRole: false, campusId })).rejects.toMatchObject({ code: 'CAMPUS_ISOLATION' });
  });
  test('global callers can narrow to an actual campus', async () => {
    await repository.paginateForAdmin({ isGlobalRole: true, requestedCampusId: B });
    expect(Announcement.find.mock.calls[0][0]).toEqual({ ...notDeletedFilter(Announcement), schoolCampus: B });
  });
  test('trash keeps the owning campus and uses its derived deletion convention', async () => {
    await repository.paginateForAdmin({ isGlobalRole: false, campusId: A, deleted: true });
    expect(Announcement.find.mock.calls[0][0]).toEqual({ ...deletedOnlyFilter(Announcement), schoolCampus: A });
  });
});

describe('transaction primitives', () => {
  test('loads with authenticated scope and the active session', () => {
    const query = repository.loadForMutation({ id: A, user: { role: 'CAMPUS_MANAGER', campusId: A } }, session);
    expect(Announcement.findOne).toHaveBeenCalledWith({ _id: A, schoolCampus: A, ...notDeletedFilter(Announcement) });
    expect(query.session).toHaveBeenCalledWith(session);
  });
  test('refuses a scoped user without a campus before querying', () => {
    expect(() => repository.loadForMutation({ id: A, user: { role: 'STAFF' } }, session)).toThrow();
    expect(Announcement.findOne).not.toHaveBeenCalled();
  });
  test('saves and reads persisted after-state with the same session', async () => {
    const doc = { _id: A, save: jest.fn() };
    await repository.saveMutation(doc, session);
    expect(doc.save).toHaveBeenCalledWith({ session });
    expect(Announcement.findById).toHaveBeenCalledWith(A);
    const query = Announcement.findById.mock.results[0].value;
    expect(query.session).toHaveBeenCalledWith(session); expect(query.lean).toHaveBeenCalled();
  });
  test('returns the transaction result and ends the session', async () => {
    await expect(repository.withTransaction(async actual => { expect(actual).toBe(session); return 42; })).resolves.toBe(42);
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });
  test('propagates failure and still ends the session', async () => {
    const error = new Error('Synthetic transaction failure');
    await expect(repository.withTransaction(async () => { throw error; })).rejects.toBe(error);
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });
});

describe('bounded due discovery and transactional recheck', () => {
  test.each([OPERATION.EXPIRE, OPERATION.UNPIN])('%s repeats the same due filter in the transaction', async operation => {
    const now = new Date('2026-11-20T09:00:00Z');
    await repository.listDue(operation, now, { afterId: A, limit: SWEEP_PAGE_SIZE });
    repository.loadDue(B, operation, now, session);
    const discovery = Announcement.find.mock.calls[0][0]; const recheck = Announcement.findOne.mock.calls[0][0];
    expect(discovery).toEqual({ ...recheck, _id: { $gt: A } });
    expect(recheck).toMatchObject(notDeletedFilter(Announcement));
    if (operation === OPERATION.EXPIRE) expect(recheck).toMatchObject({ status: STATUS.PUBLISHED, expiresAt: { $ne: null, $lte: now } });
    else expect(recheck).toMatchObject({ pinned: true, pinnedUntil: { $ne: null, $lte: now } });
    const query = Announcement.find.mock.results[0].value;
    expect(query.sort).toHaveBeenCalledWith({ _id: 1 }); expect(query.limit).toHaveBeenCalledWith(SWEEP_PAGE_SIZE);
    expect(Announcement.findOne.mock.results[0].value.session).toHaveBeenCalledWith(session);
  });
});
