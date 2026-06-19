'use strict';

/**
 * Repository layer — campus module (R2, the hub). Campus model mocked (no DB).
 */

jest.mock('../../modules/campus/campus.model', () => {
  let leanVal = null;
  const makeQuery = () => {
    const q = {};
    ['select', 'sort', 'skip', 'limit'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.lean = jest.fn(() => Promise.resolve(leanVal));
    return q;
  };
  return {
    find:              jest.fn(() => makeQuery()),
    findOne:           jest.fn(() => makeQuery()),
    findById:          jest.fn(() => makeQuery()),
    findByIdAndUpdate: jest.fn(() => makeQuery()),
    updateOne:         jest.fn(() => Promise.resolve({})),
    countDocuments:    jest.fn(() => Promise.resolve(3)),
    create:            jest.fn((d) => Promise.resolve({ _id: 'new', ...d })),
    __setLean: (v) => { leanVal = v; },
  };
});

const Campus = require('../../modules/campus/campus.model');
const repo = require('../../modules/campus/campus.repository');

beforeEach(() => {
  jest.clearAllMocks();
  Campus.__setLean(null);
});

describe('controller', () => {
  test('findByEmailWithPassword : findOne(email) + select(+password)', async () => {
    const q = Campus.findOne();
    Campus.findOne.mockClear();
    Campus.findOne.mockReturnValueOnce(q);
    await repo.findByEmailWithPassword('a@b.co');
    expect(Campus.findOne).toHaveBeenCalledWith({ email: 'a@b.co' });
    expect(q.select).toHaveBeenCalledWith('+password');
  });

  test('paginate : filtre status + city + recherche $or', async () => {
    await repo.paginate({ status: 'active', city: 'Yaoundé', search: 'a.b', skip: 0, limit: 50 });
    const filter = Campus.find.mock.calls[0][0];
    expect(filter.status).toBe('active');
    expect(filter['location.city'].$regex).toBe('Yaoundé');
    expect(filter.$or).toHaveLength(4);
    expect(filter.$or[0].campus_name.$regex).toBe('a\\.b');
  });

  test('paginate : projection -password par défaut (vue privilégiée)', async () => {
    const q = Campus.find();
    Campus.find.mockClear();
    Campus.find.mockReturnValueOnce(q);
    await repo.paginate({ skip: 0, limit: 50 });
    expect(q.select).toHaveBeenCalledWith('-password');
  });

  test('paginate : publicView restreint aux champs publics (pas d email/téléphone)', async () => {
    const q = Campus.find();
    Campus.find.mockClear();
    Campus.find.mockReturnValueOnce(q);
    await repo.paginate({ skip: 0, limit: 50, publicView: true });
    const projection = q.select.mock.calls[0][0];
    expect(projection).not.toContain('email');
    expect(projection).not.toContain('manager_phone');
    expect(projection).not.toContain('commissionConfig');
    expect(projection).toContain('campus_name');
  });

  test('touchLastLogin : updateOne $set lastLogin', async () => {
    await repo.touchLastLogin('c1');
    const [filter, update] = Campus.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'c1' });
    expect(update.$set.lastLogin).toBeInstanceOf(Date);
  });

  test('updateDefaults : findByIdAndUpdate $set + projection', async () => {
    const q = Campus.findByIdAndUpdate();
    Campus.findByIdAndUpdate.mockClear();
    Campus.findByIdAndUpdate.mockReturnValueOnce(q);
    await repo.updateDefaults('c1', { defaultLanguage: 'fr' });
    const [id, update, opts] = Campus.findByIdAndUpdate.mock.calls[0];
    expect(id).toBe('c1');
    expect(update).toEqual({ $set: { defaultLanguage: 'fr' } });
    expect(opts).toEqual({ new: true, runValidators: true });
    expect(q.select).toHaveBeenCalledWith('defaultLanguage defaultTimezone defaultGradeFormat campus_name');
  });
});

describe('service inter-modules', () => {
  test('getActiveCampusBySlug : filtre actif + select par défaut _id', async () => {
    const q = Campus.findOne();
    Campus.findOne.mockClear();
    Campus.findOne.mockReturnValueOnce(q);
    await repo.getActiveCampusBySlug('campus-douala');
    expect(Campus.findOne).toHaveBeenCalledWith({ campusSlug: 'campus-douala', status: 'active' });
    expect(q.select).toHaveBeenCalledWith('_id');
  });

  test('listActivePublicCampuses : actifs + slug non null, tri par nom', async () => {
    const q = Campus.find();
    Campus.find.mockClear();
    Campus.find.mockReturnValueOnce(q);
    await repo.listActivePublicCampuses('campus_name campusSlug');
    expect(Campus.find).toHaveBeenCalledWith({ status: 'active', campusSlug: { $ne: null } });
    expect(q.sort).toHaveBeenCalledWith({ campus_name: 1 });
  });

  test('getCampusDocById : pas de lean (doc pour methodes d instance)', async () => {
    const q = Campus.findById();
    Campus.findById.mockClear();
    Campus.findById.mockReturnValueOnce(q);
    repo.getCampusDocById('c1');
    expect(Campus.findById).toHaveBeenCalledWith('c1');
    expect(q.lean).not.toHaveBeenCalled();
  });
});
