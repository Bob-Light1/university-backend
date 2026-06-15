'use strict';

/**
 * Couche repository — module admin (R2). Model mocké (sans DB).
 */

jest.mock('../../modules/admin/admin.model', () => {
  let nextLean = null;
  let nextDoc = null;
  const makeQuery = () => {
    const q = {};
    ['select', 'populate', 'sort', 'skip', 'limit'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.lean = jest.fn(() => Promise.resolve(nextLean));
    q.then = (res, rej) => Promise.resolve(nextDoc).then(res, rej);
    return q;
  };
  return {
    findOne:           jest.fn(() => makeQuery()),
    find:              jest.fn(() => makeQuery()),
    findById:          jest.fn(() => makeQuery()),
    findByIdAndUpdate: jest.fn(() => Promise.resolve()),
    updateOne:         jest.fn(() => Promise.resolve()),
    countDocuments:    jest.fn(() => Promise.resolve(2)),
    create:            jest.fn((d) => Promise.resolve({ _id: 'new', ...d })),
    __setLean: (v) => { nextLean = v; },
    __setDoc:  (v) => { nextDoc = v; },
  };
});

const Admin = require('../../modules/admin/admin.model');
const repo = require('../../modules/admin/admin.repository');

beforeEach(() => {
  jest.clearAllMocks();
  Admin.__setLean(null);
  Admin.__setDoc(null);
});

describe('login & lookups', () => {
  test('findByEmailWithPassword : findOne(email) + select(+password) + lean', async () => {
    const q = Admin.findOne();
    Admin.findOne.mockClear();
    Admin.findOne.mockReturnValueOnce(q);
    await repo.findByEmailWithPassword('a@b.co');
    expect(Admin.findOne).toHaveBeenCalledWith({ email: 'a@b.co' });
    expect(q.select).toHaveBeenCalledWith('+password');
    expect(q.lean).toHaveBeenCalled();
  });

  test('touchLastLogin : updateOne $set lastLogin', async () => {
    await repo.touchLastLogin('a1');
    const [filter, update] = Admin.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'a1' });
    expect(update.$set.lastLogin).toBeInstanceOf(Date);
  });

  test('count délègue à countDocuments', async () => {
    expect(await repo.count()).toBe(2);
  });
});

describe('paginate', () => {
  test('applique role/status/search et renvoie { data, total }', async () => {
    Admin.__setLean([{ _id: '1' }]);
    const out = await repo.paginate({ role: 'ADMIN', status: 'active', search: 'a.b', skip: 0, limit: 20 });
    const filter = Admin.find.mock.calls[0][0];
    expect(filter.role).toBe('ADMIN');
    expect(filter.status).toBe('active');
    expect(filter.$or[0].admin_name.$regex).toBe('a\\.b');
    expect(out).toEqual({ data: [{ _id: '1' }], total: 2 });
  });

  test('sans filtres → filtre vide', async () => {
    await repo.paginate({ skip: 0, limit: 20 });
    expect(Admin.find).toHaveBeenCalledWith({});
  });
});

describe('applyStatusChange', () => {
  test('introuvable → null', async () => {
    Admin.__setDoc(null);
    expect(await repo.applyStatusChange('x', { status: 'inactive' })).toBeNull();
  });

  test('change le statut, empile l historique, save', async () => {
    const history = [];
    const save = jest.fn().mockResolvedValue();
    Admin.__setDoc({ status: 'active', statusHistory: history, save });
    const out = await repo.applyStatusChange('a1', { status: 'suspended', changedBy: 'admin', note: ' x ' });
    expect(out.status).toBe('suspended');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ status: 'suspended', changedBy: 'admin', note: 'x' });
    expect(save).toHaveBeenCalled();
  });
});
