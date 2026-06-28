'use strict';

/**
 * Repository layer — settings module (R1).
 * Locks down the UserPreferences queries (projected read, lazy upserts,
 * upsert with $set, SUPPORTED_LANGUAGES static). Model mocked (no DB).
 */

jest.mock('../../modules/settings/models/userPreferences.model', () => {
  const chain = (val) => ({
    select: jest.fn().mockReturnThis(),
    lean:   jest.fn().mockResolvedValue(val),
  });
  return {
    findOne:          jest.fn(() => chain({ userId: 'u1', preferredLanguage: 'fr' })),
    find:             jest.fn(() => chain([{ userId: 'u1', preferredLanguage: 'fr' }])),
    findOneAndUpdate: jest.fn(() => chain({ userId: 'u1', preferredLanguage: 'fr', timezone: 'UTC' })),
    schema: { statics: { SUPPORTED_LANGUAGES: ['en', 'fr', 'es'] } },
  };
});

const UserPreferences = require('../../modules/settings/models/userPreferences.model');
const repo = require('../../modules/settings/settings.repository');

beforeEach(() => jest.clearAllMocks());

const UPSERT_OPTS = { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true };

describe('lectures', () => {
  test('findByUserId : findOne({ userId }) en lean', async () => {
    await repo.findByUserId('u1');
    expect(UserPreferences.findOne).toHaveBeenCalledWith({ userId: 'u1' });
  });

  test('findLanguageByUserId : projette preferredLanguage', async () => {
    const q = UserPreferences.findOne();
    UserPreferences.findOne.mockClear();
    UserPreferences.findOne.mockReturnValueOnce(q);
    await repo.findLanguageByUserId('u1');
    expect(UserPreferences.findOne).toHaveBeenCalledWith({ userId: 'u1' });
    expect(q.select).toHaveBeenCalledWith('preferredLanguage');
  });

  test('findLanguagesByUserIds : find({ $in }) projeté userId+langue', async () => {
    const q = UserPreferences.find();
    UserPreferences.find.mockClear();
    UserPreferences.find.mockReturnValueOnce(q);
    const rows = await repo.findLanguagesByUserIds(['u1', 'u2']);
    expect(UserPreferences.find).toHaveBeenCalledWith({ userId: { $in: ['u1', 'u2'] } });
    expect(q.select).toHaveBeenCalledWith('userId preferredLanguage');
    expect(rows).toEqual([{ userId: 'u1', preferredLanguage: 'fr' }]);
  });
});

describe('upserts', () => {
  test('upsertOnInsert : $setOnInsert + options upsert', async () => {
    const insertDoc = { userId: 'u1', userModel: 'Admin', campusId: 'c1' };
    await repo.upsertOnInsert('u1', insertDoc);
    expect(UserPreferences.findOneAndUpdate).toHaveBeenCalledWith(
      { userId: 'u1' },
      { $setOnInsert: insertDoc },
      UPSERT_OPTS,
    );
  });

  test('upsertWithSet : $set + $setOnInsert', async () => {
    const set = { preferredLanguage: 'es' };
    const insertDoc = { userId: 'u1', userModel: 'Admin', campusId: 'c1' };
    await repo.upsertWithSet('u1', set, insertDoc);
    expect(UserPreferences.findOneAndUpdate).toHaveBeenCalledWith(
      { userId: 'u1' },
      { $set: set, $setOnInsert: insertDoc },
      UPSERT_OPTS,
    );
  });

  test('upsertOnInsert : absorbs the unique-index race (E11000) by retrying once', async () => {
    const dup = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    const ok  = { userId: 'u1', preferredLanguage: 'fr' };
    UserPreferences.findOneAndUpdate
      .mockReturnValueOnce({ lean: () => Promise.reject(dup) })
      .mockReturnValueOnce({ lean: () => Promise.resolve(ok) });

    const res = await repo.upsertOnInsert('u1', { userId: 'u1', userModel: 'Admin' });
    expect(res).toEqual(ok);
    expect(UserPreferences.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  test('upsertOnInsert : rethrows non-duplicate errors without retry', async () => {
    const boom = Object.assign(new Error('network down'), { code: 'ECONNRESET' });
    UserPreferences.findOneAndUpdate.mockReturnValueOnce({ lean: () => Promise.reject(boom) });

    await expect(repo.upsertOnInsert('u1', { userId: 'u1', userModel: 'Admin' })).rejects.toThrow('network down');
    expect(UserPreferences.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('getSupportedLanguages', () => {
  test('renvoie la statique du schéma', () => {
    expect(repo.getSupportedLanguages()).toEqual(['en', 'fr', 'es']);
  });
});
