'use strict';

/**
 * Couche repository — module class (R2, cœur académique). Model Class mocké.
 */

jest.mock('../../modules/class/class.model', () => {
  let leanVal = null;
  let nextDoc = null;
  const makeQuery = () => {
    const q = {};
    ['select', 'populate', 'sort', 'skip', 'limit', 'session'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.lean = jest.fn(() => Promise.resolve(leanVal));
    q.then = (res, rej) => Promise.resolve(nextDoc).then(res, rej);
    return q;
  };
  return {
    find:           jest.fn(() => makeQuery()),
    findOne:        jest.fn(() => makeQuery()),
    findById:       jest.fn(() => makeQuery()),
    countDocuments: jest.fn(() => Promise.resolve(6)),
    updateMany:     jest.fn(() => Promise.resolve({ modifiedCount: 2 })),
    updateOne:      jest.fn(() => Promise.resolve({ modifiedCount: 1 })),
    create:         jest.fn((d) => Promise.resolve({ _id: 'new', ...d })),
    __setLean: (v) => { leanVal = v; },
    __setDoc:  (v) => { nextDoc = v; },
  };
});

const Class = require('../../modules/class/class.model');
const repo = require('../../modules/class/class.repository');

beforeEach(() => {
  jest.clearAllMocks();
  Class.__setLean(null);
  Class.__setDoc(null);
});

describe('controller', () => {
  test('findDuplicate : filtre campus/level/className + exceptId', async () => {
    await repo.findDuplicate({ schoolCampus: 'c1', level: 'l1', className: 'CM1', exceptId: 'k0' });
    expect(Class.findOne).toHaveBeenCalledWith({ schoolCampus: 'c1', level: 'l1', className: 'CM1', _id: { $ne: 'k0' } });
  });

  test('paginate : défaut exclut archivés + level/recherche', async () => {
    await repo.paginate({ baseFilter: { schoolCampus: 'c1' }, level: 'l1', search: 'a.b', skip: 0, limit: 20 });
    const filter = Class.find.mock.calls[0][0];
    expect(filter.status).toEqual({ $ne: 'archived' });
    expect(filter.level).toBe('l1');
    expect(filter.className.$regex).toBe('a\\.b');
  });

  test('listByCampus : status par défaut = active', async () => {
    await repo.listByCampus({ campusId: 'c1' });
    expect(Class.find).toHaveBeenCalledWith({ schoolCampus: 'c1', status: 'active' });
  });

  test('listByTeacher : $or classManager / teachers, hors archivés', async () => {
    await repo.listByTeacher({ campusFilter: { schoolCampus: 'c1' }, teacherId: 't1' });
    const filter = Class.find.mock.calls[0][0];
    expect(filter.status).toEqual({ $ne: 'archived' });
    expect(filter.$or).toEqual([{ classManager: 't1' }, { teachers: 't1' }]);
  });

  test('applyUpdate : introuvable → null ; sinon assign + save', async () => {
    Class.__setDoc(null);
    expect(await repo.applyUpdate('x', { className: 'Z' })).toBeNull();

    const save = jest.fn().mockResolvedValue();
    Class.__setDoc({ _id: 'k1', className: 'old', save });
    const out = await repo.applyUpdate('k1', { className: 'NEW' });
    expect(out.className).toBe('NEW');
    expect(save).toHaveBeenCalled();
  });
});

describe('service inter-modules', () => {
  test('countOnCampus : { _id:$in, schoolCampus }', async () => {
    await repo.countOnCampus(['a', 'b'], 'c1');
    expect(Class.countDocuments).toHaveBeenCalledWith({ _id: { $in: ['a', 'b'] }, schoolCampus: 'c1' });
  });

  test('resolveForSchedule : vide → {classes:[],invalid:[]} sans requête', async () => {
    const out = await repo.resolveForSchedule([], 'c1');
    expect(out).toEqual({ classes: [], invalid: [] });
    expect(Class.find).not.toHaveBeenCalled();
  });

  test('resolveForSchedule : forme dénormalisée + invalides détectés', async () => {
    Class.__setLean([{ _id: { toString: () => 'k1' }, className: 'CM1', level: 'l1' }]);
    const out = await repo.resolveForSchedule(['k1', 'k2'], 'c1');
    expect(Class.find).toHaveBeenCalledWith({ _id: { $in: ['k1', 'k2'] }, schoolCampus: 'c1', status: { $ne: 'archived' } });
    expect(out.classes).toEqual([{ classId: { toString: expect.any(Function) }, className: 'CM1', level: 'l1' }]);
    expect(out.invalid).toEqual(['k2']);
  });

  test('addTeacherToClasses : no-op si vide', async () => {
    const out = await repo.addTeacherToClasses({ teacherId: 't1', classIds: [], campusId: 'c1' });
    expect(out).toBeNull();
    expect(Class.updateMany).not.toHaveBeenCalled();
  });

  test('clearClassManager : ne retire que si teacherId occupe', async () => {
    await repo.clearClassManager({ classId: 'k1', teacherId: 't1', campusId: 'c1' });
    const [filter, update] = Class.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'k1', classManager: 't1', schoolCampus: 'c1' });
    expect(update).toEqual({ $set: { classManager: null } });
  });
});
