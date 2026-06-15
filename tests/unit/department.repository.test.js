'use strict';

/**
 * Couche repository — module department (R1).
 * Verrouille les filtres (unicité, pagination campus/statut/recherche) et la
 * sémantique des écritures. Le model Department est mocké (sans DB).
 */

jest.mock('../../modules/department/department.model', () => {
  let nextLean = null;
  let nextDoc = null;
  const makeQuery = () => {
    const q = {};
    ['populate', 'select', 'session', 'sort', 'skip', 'limit'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.lean = jest.fn(() => Promise.resolve(nextLean));
    q.then = (res, rej) => Promise.resolve(nextDoc).then(res, rej); // thenable : `await findById(id)`
    return q;
  };
  return {
    findOne:            jest.fn(() => makeQuery()),
    find:               jest.fn(() => makeQuery()),
    findById:           jest.fn(() => makeQuery()),
    findByIdAndUpdate:  jest.fn(() => makeQuery()),
    countDocuments:     jest.fn(() => Promise.resolve(5)),
    create:             jest.fn((d) => Promise.resolve({ _id: 'new', ...d })),
    __setLean: (v) => { nextLean = v; },
    __setDoc:  (v) => { nextDoc = v; },
  };
});

const Department = require('../../modules/department/department.model');
const repo = require('../../modules/department/department.repository');

beforeEach(() => {
  jest.clearAllMocks();
  Department.__setLean(null);
  Department.__setDoc(null);
});

describe('contrôles d unicité', () => {
  test('findByNameInCampus filtre sur { schoolCampus, name }', async () => {
    await repo.findByNameInCampus('c1', 'Maths');
    expect(Department.findOne).toHaveBeenCalledWith({ schoolCampus: 'c1', name: 'Maths' });
  });

  test('findByCodeInCampusExcept exclut l id courant', async () => {
    await repo.findByCodeInCampusExcept('c1', 'MAT', 'dep1');
    expect(Department.findOne).toHaveBeenCalledWith({ schoolCampus: 'c1', code: 'MAT', _id: { $ne: 'dep1' } });
  });
});

describe('paginate', () => {
  test('par défaut exclut les archivés et fusionne le baseFilter campus', async () => {
    await repo.paginate({ baseFilter: { schoolCampus: 'c1' }, skip: 0, limit: 10 });
    expect(Department.find).toHaveBeenCalledWith({ schoolCampus: 'c1', status: { $ne: 'archived' } });
  });

  test('un status explicite prime sur l exclusion des archivés', async () => {
    await repo.paginate({ baseFilter: {}, status: 'archived', skip: 0, limit: 10 });
    expect(Department.find).toHaveBeenCalledWith({ status: 'archived' });
  });

  test('includeArchived=true → pas de filtre de statut', async () => {
    await repo.paginate({ baseFilter: {}, includeArchived: true, skip: 0, limit: 10 });
    expect(Department.find).toHaveBeenCalledWith({});
  });

  test('search → $or sur name/code/description (regex échappée)', async () => {
    await repo.paginate({ baseFilter: {}, search: 'a.b', skip: 0, limit: 10 });
    const filter = Department.find.mock.calls[0][0];
    expect(filter.$or).toHaveLength(3);
    expect(filter.$or[0].name.$regex).toBe('a\\.b');
  });

  test('renvoie { data, total }', async () => {
    Department.__setLean([{ _id: '1' }]);
    const out = await repo.paginate({ baseFilter: {}, skip: 0, limit: 10 });
    expect(out).toEqual({ data: [{ _id: '1' }], total: 5 });
  });
});

describe('écritures', () => {
  test('updateById utilise findByIdAndUpdate { new, runValidators }', async () => {
    await repo.updateById('dep1', { name: 'X' });
    expect(Department.findByIdAndUpdate).toHaveBeenCalledWith('dep1', { name: 'X' }, { new: true, runValidators: true });
  });

  test('setStatus introuvable → null', async () => {
    Department.__setDoc(null);
    expect(await repo.setStatus('nope', 'archived')).toBeNull();
  });

  test('setStatus charge, change le statut et save', async () => {
    const save = jest.fn().mockResolvedValue();
    Department.__setDoc({ _id: 'dep1', status: 'active', save });
    const out = await repo.setStatus('dep1', 'archived');
    expect(out.status).toBe('archived');
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('API inter-modules', () => {
  test('getCampusRef : select + session + lean', async () => {
    const q = Department.findById();
    Department.findById.mockClear();
    Department.findById.mockReturnValueOnce(q);
    await repo.getCampusRef('dep1', { session: 'S' });
    expect(q.select).toHaveBeenCalledWith('schoolCampus name');
    expect(q.session).toHaveBeenCalledWith('S');
    expect(q.lean).toHaveBeenCalled();
  });

  test('findForBulk : findById + session', async () => {
    const q = Department.findById();
    Department.findById.mockClear();
    Department.findById.mockReturnValueOnce(q);
    repo.findForBulk('dep1', 'S');
    expect(Department.findById).toHaveBeenCalledWith('dep1');
    expect(q.session).toHaveBeenCalledWith('S');
  });
});
