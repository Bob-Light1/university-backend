'use strict';

/**
 * Repository layer — announcement module (R1).
 * Locks down the filters (admin campus isolation + visible scope), the
 * load→mutate→save semantics of applyUpdate, and the cron queries. Models mocked (no DB).
 */

jest.mock('../../modules/announcement/models/announcement.model', () => {
  const makeChain = (result) => {
    const q = {};
    q.sort = jest.fn(() => q);
    q.skip = jest.fn(() => q);
    q.limit = jest.fn(() => q);
    q.select = jest.fn(() => q);
    q.lean = jest.fn().mockResolvedValue(result);
    q.distinct = jest.fn().mockResolvedValue(result);
    return q;
  };
  let nextDoc = null;
  return {
    create:         jest.fn((d) => Promise.resolve({ _id: 'new', ...d })),
    find:           jest.fn(() => makeChain([{ _id: '1' }])),
    findOne:        jest.fn(() => {
      const p = Promise.resolve(nextDoc);
      p.lean = jest.fn().mockResolvedValue(nextDoc);
      return p;
    }),
    countDocuments: jest.fn().mockResolvedValue(3),
    updateMany:     jest.fn().mockResolvedValue({ modifiedCount: 2 }),
    __setDoc: (d) => { nextDoc = d; },
  };
});

jest.mock('../../modules/announcement/models/user-notification.model', () => {
  const chain = { select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) };
  return {
    find:           jest.fn(() => chain),
    countDocuments: jest.fn().mockResolvedValue(0),
    updateOne:      jest.fn().mockResolvedValue({}),
    bulkWrite:      jest.fn().mockResolvedValue({}),
  };
});

const Announcement = require('../../modules/announcement/models/announcement.model');
const repo = require('../../modules/announcement/announcement.repository');

beforeEach(() => {
  jest.clearAllMocks();
  Announcement.__setDoc(null);
});

describe('paginateForAdmin — isolation campus', () => {
  test('rôle non-global → verrouillé sur son campus + non supprimés', async () => {
    await repo.paginateForAdmin({ isGlobalRole: false, campusId: 'c1', skip: 0, limit: 20 });
    const filter = Announcement.find.mock.calls[0][0];
    expect(filter).toMatchObject({ deletedAt: null, schoolCampus: 'c1' });
  });

  test('rôle global + campus demandé → ciblé sur ce campus', async () => {
    await repo.paginateForAdmin({ isGlobalRole: true, campusId: 'c1', requestedCampusId: 'c2', skip: 0, limit: 20 });
    expect(Announcement.find.mock.calls[0][0]).toMatchObject({ deletedAt: null, schoolCampus: 'c2' });
  });

  test('rôle global sans campus demandé → pas de restriction campus', async () => {
    await repo.paginateForAdmin({ isGlobalRole: true, campusId: 'c1', skip: 0, limit: 20 });
    const filter = Announcement.find.mock.calls[0][0];
    expect(filter).toEqual({ deletedAt: null });
  });

  test('tri épinglé puis récent', async () => {
    const chain = Announcement.find();
    Announcement.find.mockClear();
    Announcement.find.mockReturnValueOnce(chain);
    await repo.paginateForAdmin({ isGlobalRole: true, skip: 0, limit: 20 });
    expect(chain.sort).toHaveBeenCalledWith({ pinned: -1, createdAt: -1 });
  });
});

describe('applyUpdate — load→assign→save', () => {
  test('introuvable → null', async () => {
    Announcement.__setDoc(null);
    expect(await repo.applyUpdate({ id: 'x', isGlobalRole: true }, { status: 'archived' })).toBeNull();
  });

  test('assigne les champs et save', async () => {
    const save = jest.fn().mockResolvedValue();
    Announcement.__setDoc({ _id: '1', status: 'draft', save });
    const out = await repo.applyUpdate({ id: '1', isGlobalRole: false, campusId: 'c1' }, { status: 'published' });
    expect(out.status).toBe('published');
    expect(save).toHaveBeenCalledTimes(1);
    // the admin scope (campus + not deleted) is applied to the search
    expect(Announcement.findOne.mock.calls[0][0]).toMatchObject({ _id: '1', deletedAt: null, schoolCampus: 'c1' });
  });
});

describe('findVisibleById — portée de visibilité', () => {
  test('filtre publié + non supprimé + campus', async () => {
    Announcement.__setDoc({ _id: '1' });
    await repo.findVisibleById({ id: '1', campusId: 'c1', role: 'STUDENT' });
    const filter = Announcement.findOne.mock.calls[0][0];
    expect(filter).toMatchObject({ _id: '1', schoolCampus: 'c1', status: 'published', deletedAt: null });
    expect(Array.isArray(filter.$and)).toBe(true);
  });
});

describe('cron', () => {
  test('archiveExpired : filtre publié+expiré, $set archived, renvoie modifiedCount', async () => {
    const now = new Date();
    const n = await repo.archiveExpired(now);
    const [filter, update] = Announcement.updateMany.mock.calls[0];
    expect(filter).toMatchObject({ status: 'published', deletedAt: null });
    expect(filter.expiresAt).toEqual({ $ne: null, $lte: now });
    expect(update).toEqual({ $set: { status: 'archived', archivedAt: now } });
    expect(n).toBe(2);
  });

  test('unpinExpired : filtre épinglé+échu, $set unpin', async () => {
    const now = new Date();
    await repo.unpinExpired(now);
    const [filter, update] = Announcement.updateMany.mock.calls[0];
    expect(filter).toMatchObject({ pinned: true, deletedAt: null });
    expect(update).toEqual({ $set: { pinned: false, pinnedUntil: null } });
  });
});
