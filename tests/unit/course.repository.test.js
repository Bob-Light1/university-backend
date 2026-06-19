'use strict';

/**
 * Couche repository — module course (R1, le plus gros).
 * Verrouille les filtres de lecture, la sémantique load→mutate→save des
 * écritures (transitions de statut, ressources, archive) et l'API inter-modules.
 * Le model Course est mocké (sans DB). La transaction cloneAsNewVersion n'est pas
 * couverte ici (mongoose.startSession) — validée au boot/intégration.
 */

jest.mock('../../modules/course/course.model', () => {
  let nextLean = null;
  let nextDoc = null;
  const makeQuery = () => {
    const q = {};
    ['populate', 'select', 'sort', 'skip', 'limit'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.lean = jest.fn(() => Promise.resolve(nextLean));
    q.then = (res, rej) => Promise.resolve(nextDoc).then(res, rej); // `await Course.findOne(...)`
    return q;
  };
  return {
    APPROVAL_STATUS: { DRAFT: 'DRAFT', PENDING_REVIEW: 'PENDING_REVIEW', APPROVED: 'APPROVED', REJECTED: 'REJECTED' },
    Course: {
      find:           jest.fn(() => makeQuery()),
      findOne:        jest.fn(() => makeQuery()),
      countDocuments: jest.fn(() => Promise.resolve(4)),
      create:         jest.fn(async (d) => ({ ...d, populate: jest.fn().mockResolvedValue() })),
    },
    __setLean: (v) => { nextLean = v; },
    __setDoc:  (v) => { nextDoc = v; },
  };
});

const model = require('../../modules/course/course.model');
const { Course } = model;
const repo = require('../../modules/course/course.repository');

beforeEach(() => {
  jest.clearAllMocks();
  model.__setLean(null);
  model.__setDoc(null);
});

describe('lectures', () => {
  test('findActiveByIdLean filtre _id + status ≠ archived', async () => {
    await repo.findActiveByIdLean('c1');
    expect(Course.findOne).toHaveBeenCalledWith({ _id: 'c1', status: { $ne: 'archived' } });
  });

  test('findLatestActiveByCode filtre code + isLatestVersion + actif', async () => {
    await repo.findLatestActiveByCode('CS101');
    expect(Course.findOne).toHaveBeenCalledWith({ courseCode: 'CS101', isLatestVersion: true, status: { $ne: 'archived' } });
  });

  test('countExistingActive compte les ids actifs', async () => {
    await repo.countExistingActive(['a', 'b']);
    expect(Course.countDocuments).toHaveBeenCalledWith({ _id: { $in: ['a', 'b'] }, status: { $ne: 'archived' } });
  });

  test('paginateList passe le filtre et renvoie { data, total }', async () => {
    model.__setLean([{ _id: '1' }]);
    const out = await repo.paginateList({ filter: { category: 'X' }, sort: { title: 1 }, skip: 0, limit: 10 });
    expect(Course.find).toHaveBeenCalledWith({ category: 'X' });
    expect(out).toEqual({ data: [{ _id: '1' }], total: 4 });
  });
});

describe('écritures load→mutate→save', () => {
  test('applyUpdate : introuvable → null', async () => {
    model.__setDoc(null);
    expect(await repo.applyUpdate('x', { title: 'Y' })).toBeNull();
  });

  test('applyUpdate : assigne, save, populate', async () => {
    const save = jest.fn().mockResolvedValue();
    const populate = jest.fn().mockResolvedValue();
    model.__setDoc({ _id: '1', title: 'old', save, populate });
    const out = await repo.applyUpdate('1', { title: 'NEW' });
    expect(out.title).toBe('NEW');
    expect(save).toHaveBeenCalledTimes(1);
    expect(populate).toHaveBeenCalledTimes(1);
  });

  test('applyStatusTransition : change le statut et empile l historique', async () => {
    const history = [];
    const save = jest.fn().mockResolvedValue();
    const populate = jest.fn().mockResolvedValue();
    model.__setDoc({ approvalStatus: 'DRAFT', approvalHistory: history, save, populate });
    const entry = { status: 'PENDING_REVIEW', note: 'go', actor: 'u1', actedAt: new Date() };
    const out = await repo.applyStatusTransition('1', { newStatus: 'PENDING_REVIEW', historyEntry: entry });
    expect(out.approvalStatus).toBe('PENDING_REVIEW');
    expect(history).toContain(entry);
    expect(save).toHaveBeenCalledTimes(1);
  });

  test('archiveById : status archived + deletedAt + deletedBy', async () => {
    const save = jest.fn().mockResolvedValue();
    const doc = { _id: '1', save };
    model.__setDoc(doc);
    await repo.archiveById('1', { deletedBy: 'admin' });
    expect(doc.status).toBe('archived');
    expect(doc.deletedBy).toBe('admin');
    expect(doc.deletedAt).toBeInstanceOf(Date);
    expect(save).toHaveBeenCalled();
  });

  test('pushResource : empile la ressource et renvoie la dernière', async () => {
    const resources = [{ _id: 'r0' }];
    const save = jest.fn().mockResolvedValue();
    model.__setDoc({ resources, save });
    const added = await repo.pushResource('1', { title: 'Doc', _id: 'r1' });
    expect(resources).toHaveLength(2);
    expect(added).toEqual({ title: 'Doc', _id: 'r1' });
    expect(save).toHaveBeenCalled();
  });

  test('pullResource : retire la ressource ciblée', async () => {
    const resources = [{ _id: { toString: () => 'r1' } }, { _id: { toString: () => 'r2' } }];
    const save = jest.fn().mockResolvedValue();
    const doc = { resources, save };
    model.__setDoc(doc);
    const ok = await repo.pullResource('1', 'r1');
    expect(ok).toBe(true);
    expect(doc.resources).toHaveLength(1);
    expect(doc.resources[0]._id.toString()).toBe('r2');
  });
});

describe('API inter-modules', () => {
  test('listApproved : filtre APPROVED + isLatestVersion + actif', async () => {
    await repo.listApproved({});
    expect(Course.find).toHaveBeenCalledWith(expect.objectContaining({
      approvalStatus: 'APPROVED', isLatestVersion: true, status: { $ne: 'archived' },
    }));
  });

  // NOTE: the former teacherOwnsAnyCourse lived here but queried a non-existent
  // Course.teacher field (always false). The teacher ↔ course relationship is
  // campus-scoped and now resolved in the subject domain
  // (subject.repository.existsTeacherLinkedToCourse); see course.service.
});
