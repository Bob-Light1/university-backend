'use strict';

/**
 * Couche repository — module parent (R2, le plus gros : 4 controllers + service).
 * Model Parent mocké (sans DB). Couvre login, pagination, transitions, agrégats
 * (cast campus) et l'API inter-modules.
 */

jest.mock('../../modules/parent/parent.model', () => {
  let leanVal = null;
  const makeQuery = () => {
    const q = {};
    ['select', 'populate', 'sort', 'skip', 'limit'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.lean = jest.fn(() => Promise.resolve(leanVal));
    q.exec = jest.fn(() => Promise.resolve());
    return q;
  };
  return {
    find:              jest.fn(() => makeQuery()),
    findOne:           jest.fn(() => makeQuery()),
    findById:          jest.fn(() => makeQuery()),
    findOneAndUpdate:  jest.fn(() => makeQuery()),
    findByIdAndUpdate: jest.fn(() => makeQuery()),
    findOneAndDelete:  jest.fn(() => Promise.resolve({ _id: 'gone' })),
    countDocuments:    jest.fn(() => Promise.resolve(9)),
    aggregate:         jest.fn(() => Promise.resolve([{ _id: 'active', count: 4 }])),
    updateMany:        jest.fn(() => ({ exec: jest.fn(() => Promise.resolve({ modifiedCount: 2 })) })),
    create:            jest.fn((d) => Promise.resolve({ _id: 'new', ...d })),
    __setLean: (v) => { leanVal = v; },
  };
});

const Parent = require('../../modules/parent/parent.model');
const repo = require('../../modules/parent/parent.repository');

beforeEach(() => {
  jest.clearAllMocks();
  Parent.__setLean(null);
});

describe('auth', () => {
  test('findByCredential : findOne(query) + select(+password)', async () => {
    const q = Parent.findOne();
    Parent.findOne.mockClear();
    Parent.findOne.mockReturnValueOnce(q);
    await repo.findByCredential({ email: 'a@b.co' });
    expect(Parent.findOne).toHaveBeenCalledWith({ email: 'a@b.co' });
    expect(q.select).toHaveBeenCalledWith('+password');
  });
});

describe('crud', () => {
  test('paginate : défaut exclut archivés + override campus + recherche', async () => {
    await repo.paginate({
      campusFilter: { schoolCampus: 'c1' }, includeArchived: false,
      campusIdOverride: 'c2', status: 'active', relationship: 'mother',
      search: 'jean', skip: 0, limit: 20,
    });
    const filter = Parent.find.mock.calls[0][0];
    expect(filter.schoolCampus).toBe('c2'); // override prime
    expect(filter.status).toBe('active');
    expect(filter.relationship).toBe('mother');
    expect(filter.$or).toHaveLength(4);
  });

  test('paginate : includeArchived → pas de filtre status par défaut', async () => {
    await repo.paginate({ campusFilter: {}, includeArchived: true, skip: 0, limit: 20 });
    expect(Parent.find).toHaveBeenCalledWith({});
  });

  test('setStatusScoped : findOneAndUpdate scope + status≠archived', async () => {
    await repo.setStatusScoped('p1', { schoolCampus: 'c1' }, 'suspended');
    const [filter, update, opts] = Parent.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'p1', schoolCampus: 'c1', status: { $ne: 'archived' } });
    expect(update).toEqual({ $set: { status: 'suspended' } });
    expect(opts).toEqual({ new: true });
  });

  test('restoreScoped : ne cible que les archivés', async () => {
    await repo.restoreScoped('p1', { schoolCampus: 'c1' });
    const [filter, update] = Parent.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'p1', schoolCampus: 'c1', status: 'archived' });
    expect(update).toEqual({ $set: { status: 'active' } });
  });
});

describe('analytics', () => {
  test('aggregateStatusBreakdown : cast schoolCampus → ObjectId dans le $match', async () => {
    await repo.aggregateStatusBreakdown({ schoolCampus: '507f1f77bcf86cd799439011' });
    const pipeline = Parent.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match.status).toEqual({ $ne: 'archived' });
    // schoolCampus casté en ObjectId (objet, pas string)
    expect(typeof pipeline[0].$match.schoolCampus).toBe('object');
    expect(String(pipeline[0].$match.schoolCampus)).toBe('507f1f77bcf86cd799439011');
  });

  test('aggregateStatusBreakdown : pas de cast si pas de campus (ADMIN global)', async () => {
    await repo.aggregateStatusBreakdown({});
    const pipeline = Parent.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match.schoolCampus).toBeUndefined();
  });

  test('findByStudent : children = studentId + actifs', async () => {
    await repo.findByStudent({ schoolCampus: 'c1' }, 's1');
    expect(Parent.find).toHaveBeenCalledWith({ schoolCampus: 'c1', children: 's1', status: { $ne: 'archived' } });
  });

  test('countArchived : status archived', async () => {
    await repo.countArchived({ schoolCampus: 'c1' });
    expect(Parent.countDocuments).toHaveBeenCalledWith({ schoolCampus: 'c1', status: 'archived' });
  });
});

describe('service inter-modules', () => {
  test('removeChildFromAll : $pull children chez tous', async () => {
    const out = await repo.removeChildFromAll('s1');
    const [filter, update] = Parent.updateMany.mock.calls[0];
    expect(filter).toEqual({ children: 's1' });
    expect(update).toEqual({ $pull: { children: 's1' } });
    expect(out.modifiedCount).toBe(2);
  });
});
