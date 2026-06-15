'use strict';

/**
 * Couche repository — module gaet (R2). Model GaetConstraint mocké (sans DB).
 * Verrouille les transitions de statut atomiques (claim/cancel/zombies) et les
 * filtres campus.
 */

jest.mock('../../modules/gaet/gaet-constraint.model', () => {
  const GAET_STATUS = {
    DRAFT: 'DRAFT', GENERATING: 'GENERATING', GENERATED: 'GENERATED',
    PARTIALLY_GENERATED: 'PARTIALLY_GENERATED', PUBLISHED: 'PUBLISHED',
    FAILED: 'FAILED', CANCELLED: 'CANCELLED',
  };
  const makeQuery = (val) => ({
    select: jest.fn().mockReturnThis(),
    lean:   jest.fn(() => Promise.resolve(val)),
  });
  return {
    GAET_STATUS,
    find:              jest.fn(() => makeQuery([{ _id: '1' }])),
    findOne:           jest.fn(() => makeQuery({ _id: '1' })),
    findById:          jest.fn(() => makeQuery({ _id: '1' })),
    findOneAndUpdate:  jest.fn(() => Promise.resolve({ _id: 'u' })),
    findByIdAndUpdate: jest.fn(() => Promise.resolve()),
    updateMany:        jest.fn(() => Promise.resolve({ modifiedCount: 3 })),
  };
});

const GaetConstraint = require('../../modules/gaet/gaet-constraint.model');
const { GAET_STATUS } = GaetConstraint;
const repo = require('../../modules/gaet/gaet.repository');

beforeEach(() => jest.clearAllMocks());

describe('lectures campus-isolées', () => {
  test('findStatusView : findOne {_id, ...campusFilter}', async () => {
    await repo.findStatusView('k1', { schoolCampus: 'c1' });
    expect(GaetConstraint.findOne).toHaveBeenCalledWith({ _id: 'k1', schoolCampus: 'c1' });
  });

  test('findByYearSemester : campus + année + semestre', async () => {
    await repo.findByYearSemester({ schoolCampus: 'c1' }, '2024-2025', 'S1');
    expect(GaetConstraint.findOne).toHaveBeenCalledWith({ schoolCampus: 'c1', academicYear: '2024-2025', semester: 'S1' });
  });
});

describe('transitions atomiques', () => {
  test('claimForGeneration : exclut GENERATING/PUBLISHED, pose GENERATING, new:false', async () => {
    await repo.claimForGeneration({ schoolCampus: 'c1' }, '2024-2025', 'S1');
    const [filter, update, opts] = GaetConstraint.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({
      schoolCampus: 'c1', academicYear: '2024-2025', semester: 'S1',
      status: { $nin: [GAET_STATUS.GENERATING, GAET_STATUS.PUBLISHED] },
    });
    expect(update.$set.status).toBe(GAET_STATUS.GENERATING);
    expect(opts).toEqual({ new: false });
  });

  test('upsert : upsert + new + setDefaultsOnInsert', async () => {
    await repo.upsert({ schoolCampus: 'c1' }, '2024-2025', 'S1', { status: 'DRAFT' });
    const [, , opts] = GaetConstraint.findOneAndUpdate.mock.calls[0];
    expect(opts).toEqual({ upsert: true, new: true, setDefaultsOnInsert: true });
  });

  test('cancel : statut autorisé $in + passage CANCELLED, new:true', async () => {
    await repo.cancel('k1', { schoolCampus: 'c1' });
    const [filter, update, opts] = GaetConstraint.findOneAndUpdate.mock.calls[0];
    expect(filter.status.$in).toEqual([GAET_STATUS.GENERATED, GAET_STATUS.PARTIALLY_GENERATED, GAET_STATUS.FAILED]);
    expect(update.$set.status).toBe(GAET_STATUS.CANCELLED);
    expect(update.$set.generatedSessions).toEqual([]);
    expect(opts).toEqual({ new: true });
  });

  test('markPublished : findByIdAndUpdate PUBLISHED + publishedBy', async () => {
    await repo.markPublished('k1', 'u1');
    const [id, update] = GaetConstraint.findByIdAndUpdate.mock.calls[0];
    expect(id).toBe('k1');
    expect(update.$set.status).toBe(GAET_STATUS.PUBLISHED);
    expect(update.$set.publishedBy).toBe('u1');
  });
});

describe('recoverZombies', () => {
  test('filtre GENERATING + ancienneté, renvoie modifiedCount', async () => {
    const n = await repo.recoverZombies(15 * 60 * 1000);
    const [filter, update] = GaetConstraint.updateMany.mock.calls[0];
    expect(filter.status).toBe(GAET_STATUS.GENERATING);
    expect(filter.generatingStartedAt.$lt).toBeInstanceOf(Date);
    expect(update.$set.status).toBe(GAET_STATUS.FAILED);
    expect(n).toBe(3);
  });
});
