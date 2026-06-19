'use strict';

/**
 * Pilote « couche repository » (étape 0 préparation Postgres).
 * Verrouille le contrat de level.repository : formes de requête correctes et
 * sémantique load→mutate→save. Le model Level est mocké (aucune DB).
 */

jest.mock('../../modules/level/level.model', () => {
  let nextDoc = null; // doc returned by findById (configurable per test)
  const leanQuery = (val) => ({
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(val),
  });
  const findById = jest.fn(() => {
    const doc = nextDoc;
    const p = Promise.resolve(doc);       // write path: `await Level.findById(id)`
    p.lean = jest.fn().mockResolvedValue(doc); // read path: `.lean()`
    return p;
  });
  return {
    findOne: jest.fn(() => leanQuery({ _id: 'exists', code: 'A1' })),
    find:    jest.fn(() => leanQuery([{ _id: '1', order: 1 }])),
    create:  jest.fn((d) => Promise.resolve({ _id: 'new', ...d })),
    findById,
    __setDoc: (d) => { nextDoc = d; },
  };
});

const Level = require('../../modules/level/level.model');
const repo = require('../../modules/level/level.repository');

beforeEach(() => {
  Level.findOne.mockClear();
  Level.find.mockClear();
  Level.findById.mockClear();
  Level.create.mockClear();
  Level.__setDoc(null);
});

describe('findByCodeAndType', () => {
  test('filtre sur { code, type } et renvoie un objet simple', async () => {
    await repo.findByCodeAndType('A1', 'LANGUAGE');
    expect(Level.findOne).toHaveBeenCalledWith({ code: 'A1', type: 'LANGUAGE' });
  });
});

describe('listActive', () => {
  test('filtre status=active, tri order croissant', async () => {
    const q = Level.find.getMockImplementation()();
    Level.find.mockReturnValueOnce(q);
    await repo.listActive();
    expect(Level.find).toHaveBeenCalledWith({ status: 'active' });
    expect(q.sort).toHaveBeenCalledWith({ order: 1 });
  });

  test('ajoute le filtre type quand fourni', async () => {
    await repo.listActive({ type: 'ACADEMIC' });
    expect(Level.find).toHaveBeenCalledWith({ status: 'active', type: 'ACADEMIC' });
  });
});

describe('create', () => {
  test('délègue à Level.create', async () => {
    const out = await repo.create({ name: 'B1', code: 'B1', order: 3 });
    expect(Level.create).toHaveBeenCalledWith({ name: 'B1', code: 'B1', order: 3 });
    expect(out._id).toBe('new');
  });
});

describe('findById', () => {
  test('lecture via .lean()', async () => {
    Level.__setDoc({ _id: 'x', name: 'A1' });
    const out = await repo.findById('x');
    expect(Level.findById).toHaveBeenCalledWith('x');
    expect(out).toEqual({ _id: 'x', name: 'A1' });
  });
});

describe('updateById', () => {
  test('introuvable → null', async () => {
    Level.__setDoc(null);
    expect(await repo.updateById('nope', { name: 'X' })).toBeNull();
  });

  test('assigne les champs fournis puis save', async () => {
    const save = jest.fn().mockResolvedValue();
    const doc = { _id: '1', name: 'old', order: 1, save };
    Level.__setDoc(doc);

    const out = await repo.updateById('1', { name: 'NEW', order: 5 });
    expect(doc.name).toBe('NEW');
    expect(doc.order).toBe(5);
    expect(save).toHaveBeenCalledTimes(1);
    expect(out).toBe(doc);
  });
});

describe('setStatus', () => {
  test('introuvable → null', async () => {
    Level.__setDoc(null);
    expect(await repo.setStatus('nope', 'archived')).toBeNull();
  });

  test('change le statut puis save', async () => {
    const save = jest.fn().mockResolvedValue();
    const doc = { _id: '1', status: 'active', save };
    Level.__setDoc(doc);

    await repo.setStatus('1', 'archived');
    expect(doc.status).toBe('archived');
    expect(save).toHaveBeenCalledTimes(1);
  });
});
