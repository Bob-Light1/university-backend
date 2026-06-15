'use strict';

/**
 * Couche repository — module mentor (R2). Model Mentor mocké (sans DB).
 */

jest.mock('../../modules/mentor/mentor.model', () => {
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
    findOneAndUpdate:  jest.fn(() => makeQuery()),
    findByIdAndUpdate: jest.fn(() => makeQuery()),
    findByIdAndDelete: jest.fn(() => Promise.resolve({ _id: 'gone' })),
    countDocuments:    jest.fn(() => Promise.resolve(5)),
    aggregate:         jest.fn(() => Promise.resolve([{ total: 12 }])),
    create:            jest.fn((d) => Promise.resolve({ _id: 'new', ...d })),
    __setLean: (v) => { leanVal = v; },
  };
});

const Mentor = require('../../modules/mentor/mentor.model');
const repo = require('../../modules/mentor/mentor.repository');

beforeEach(() => {
  jest.clearAllMocks();
  Mentor.__setLean(null);
});

describe('login', () => {
  test('findByCredential : findOne(query) + select(+password)', async () => {
    const q = Mentor.findOne();
    Mentor.findOne.mockClear();
    Mentor.findOne.mockReturnValueOnce(q);
    await repo.findByCredential({ email: 'a@b.co' });
    expect(Mentor.findOne).toHaveBeenCalledWith({ email: 'a@b.co' });
    expect(q.select).toHaveBeenCalledWith('+password');
  });

  test('touchLastLogin : findByIdAndUpdate lastLogin + exec', async () => {
    await repo.touchLastLogin('m1');
    const [id, update] = Mentor.findByIdAndUpdate.mock.calls[0];
    expect(id).toBe('m1');
    expect(update.lastLogin).toBeInstanceOf(Date);
  });
});

describe('paginate', () => {
  test('défaut exclut archivés + fusionne campusFilter', async () => {
    await repo.paginate({ campusFilter: { schoolCampus: 'c1' }, skip: 0, limit: 20 });
    expect(Mentor.find).toHaveBeenCalledWith({ schoolCampus: 'c1', status: { $ne: 'archived' } });
  });

  test('status explicite prime', async () => {
    await repo.paginate({ campusFilter: {}, status: 'suspended', skip: 0, limit: 20 });
    expect(Mentor.find).toHaveBeenCalledWith({ status: 'suspended' });
  });

  test('renvoie { data, total }', async () => {
    Mentor.__setLean([{ _id: '1' }]);
    const out = await repo.paginate({ campusFilter: {}, skip: 0, limit: 20 });
    expect(out).toEqual({ data: [{ _id: '1' }], total: 5 });
  });
});

describe('écritures scoped', () => {
  test('setStatusScoped : findOneAndUpdate $set status, new:true', async () => {
    await repo.setStatusScoped({ _id: 'm1', schoolCampus: 'c1' }, 'archived');
    const [filter, update, opts] = Mentor.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'm1', schoolCampus: 'c1' });
    expect(update).toEqual({ $set: { status: 'archived' } });
    expect(opts).toEqual({ new: true });
  });

  test('updateScoped : $set body + runValidators', async () => {
    await repo.updateScoped({ _id: 'm1' }, { firstName: 'X' });
    const [, update, opts] = Mentor.findOneAndUpdate.mock.calls[0];
    expect(update).toEqual({ $set: { firstName: 'X' } });
    expect(opts).toEqual({ new: true, runValidators: true });
  });

  test('applyStudentAssignment : findByIdAndUpdate op + new', async () => {
    await repo.applyStudentAssignment('m1', { $set: { students: ['s1'] } });
    const [id, op, opts] = Mentor.findByIdAndUpdate.mock.calls[0];
    expect(id).toBe('m1');
    expect(op).toEqual({ $set: { students: ['s1'] } });
    expect(opts).toEqual({ new: true });
  });
});

describe('stats (service)', () => {
  test('countByCampus : countDocuments { schoolCampus, status }', async () => {
    await repo.countByCampus('c1', { $ne: 'archived' });
    expect(Mentor.countDocuments).toHaveBeenCalledWith({ schoolCampus: 'c1', status: { $ne: 'archived' } });
  });

  test('aggregateAssignedStudents : $match campus + $sum $size students', async () => {
    const out = await repo.aggregateAssignedStudents('oid');
    const pipeline = Mentor.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match).toMatchObject({ schoolCampus: 'oid', status: { $ne: 'archived' } });
    expect(out).toEqual([{ total: 12 }]);
  });
});
