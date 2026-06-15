'use strict';

/**
 * Couche repository — module staff (R2, 2 modèles). Models mockés (sans DB).
 */

jest.mock('../../modules/staff/models/staff.model', () => {
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
    findByIdAndDelete: jest.fn(() => Promise.resolve({ _id: 'gone' })),
    countDocuments:    jest.fn(() => Promise.resolve(7)),
    exists:            jest.fn(() => Promise.resolve(true)),
    create:            jest.fn((d) => Promise.resolve({ _id: 'new', ...d })),
    __setLean: (v) => { leanVal = v; },
  };
});

jest.mock('../../modules/staff/models/staffRole.model', () => {
  let leanVal = null;
  const makeQuery = () => {
    const q = {};
    ['populate', 'sort', 'skip', 'limit'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.lean = jest.fn(() => Promise.resolve(leanVal));
    return q;
  };
  return {
    find:              jest.fn(() => makeQuery()),
    findOne:           jest.fn(() => makeQuery()),
    findOneAndUpdate:  jest.fn(() => makeQuery()),
    findByIdAndUpdate: jest.fn(() => makeQuery()),
    findByIdAndDelete: jest.fn(() => Promise.resolve()),
    countDocuments:    jest.fn(() => Promise.resolve(2)),
    create:            jest.fn((d) => Promise.resolve({ _id: 'r', ...d })),
    __setLean: (v) => { leanVal = v; },
  };
});

const Staff = require('../../modules/staff/models/staff.model');
const StaffRole = require('../../modules/staff/models/staffRole.model');
const staffRepo = require('../../modules/staff/staff.repository');
const staffRoleRepo = require('../../modules/staff/staffRole.repository');

beforeEach(() => {
  jest.clearAllMocks();
  Staff.__setLean(null);
  StaffRole.__setLean(null);
});

describe('staff.repository', () => {
  test('findByCredential : select +password + populate subRole', async () => {
    const q = Staff.findOne();
    Staff.findOne.mockClear();
    Staff.findOne.mockReturnValueOnce(q);
    await staffRepo.findByCredential({ email: 'a@b.co' });
    expect(Staff.findOne).toHaveBeenCalledWith({ email: 'a@b.co' });
    expect(q.select).toHaveBeenCalledWith('+password');
    expect(q.populate).toHaveBeenCalledWith('subRole', 'name permissions isActive');
  });

  test('paginate : défaut exclut archivés + subRole filtre', async () => {
    await staffRepo.paginate({ campusFilter: { schoolCampus: 'c1' }, subRole: 'r1', skip: 0, limit: 20 });
    expect(Staff.find).toHaveBeenCalledWith({ schoolCampus: 'c1', status: { $ne: 'archived' }, subRole: 'r1' });
  });

  test('setStatusScoped : findOneAndUpdate $set status new:true', async () => {
    await staffRepo.setStatusScoped({ _id: 's1', schoolCampus: 'c1' }, 'archived');
    const [filter, update, opts] = Staff.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 's1', schoolCampus: 'c1' });
    expect(update).toEqual({ $set: { status: 'archived' } });
    expect(opts).toEqual({ new: true });
  });

  test('isRoleInUse : Staff.exists { subRole }', async () => {
    const out = await staffRepo.isRoleInUse('r1');
    expect(Staff.exists).toHaveBeenCalledWith({ subRole: 'r1' });
    expect(out).toBe(true);
  });

  test('countByCampus : merge schoolCampus + critères', async () => {
    await staffRepo.countByCampus('c1', { status: 'active' });
    expect(Staff.countDocuments).toHaveBeenCalledWith({ schoolCampus: 'c1', status: 'active' });
  });
});

describe('staffRole.repository', () => {
  test('findActiveInCampus : { _id, campus, isActive:true }', async () => {
    await staffRoleRepo.findActiveInCampus('r1', 'c1');
    expect(StaffRole.findOne).toHaveBeenCalledWith({ _id: 'r1', campus: 'c1', isActive: true });
  });

  test('paginate : campusScope → clé `campus`', async () => {
    await staffRoleRepo.paginate({ campusScope: 'c1', skip: 0, limit: 50 });
    expect(StaffRole.find).toHaveBeenCalledWith({ campus: 'c1' });
  });

  test('paginate : campusScope absent (global) → pas de filtre campus', async () => {
    await staffRoleRepo.paginate({ campusScope: undefined, isActive: true, skip: 0, limit: 50 });
    expect(StaffRole.find).toHaveBeenCalledWith({ isActive: true });
  });

  test('findOneScoped : scope sans campus si global', async () => {
    await staffRoleRepo.findOneScoped('r1', undefined);
    expect(StaffRole.findOne).toHaveBeenCalledWith({ _id: 'r1' });
  });

  test('setActive : findByIdAndUpdate isActive new:true', async () => {
    await staffRoleRepo.setActive('r1', false);
    const [id, update, opts] = StaffRole.findByIdAndUpdate.mock.calls[0];
    expect(id).toBe('r1');
    expect(update).toEqual({ $set: { isActive: false } });
    expect(opts).toEqual({ new: true });
  });
});
