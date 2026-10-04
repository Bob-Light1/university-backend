'use strict';

/**
 * @file fixture-expansion.test.js
 * @description Schema and clock regression checks for the eight CH-0 additions.
 */
const { buildAll, createContext } = require('../fixtures/seed');
const { model } = require('../fixtures/models');
const { COUNTS, CAMPUS_KEYS } = require('../fixtures/seed.config');

const COLLECTIONS = {
  GaetConstraint: 'gaetConstraints', Notification: 'notifications',
  UserPreferences: 'userPreferences', PrintJob: 'printJobs',
  FinalTranscript: 'finalTranscripts', DocumentVersion: 'documentVersions',
  DocumentShare: 'documentShares', DocumentTemplate: 'documentTemplates',
};

/** Build through the production fixture entry point, including Mongoose defaults. */
const snapshot = () => Object.fromEntries(buildAll(createContext('synthetic-hash'))
  .filter(group => Object.hasOwn(COLLECTIONS, group.model))
  .map(group => [group.model, group.docs.map(data => {
    const document = new (model(group.model))(data);
    const error = document.validateSync();
    if (error) throw error;
    return document.toObject({ virtuals: false });
  })]));

describe('CH-0 additional collections', () => {
  afterEach(() => jest.useRealTimers());

  it.each(Object.entries(COLLECTIONS))('seeds schema-valid %s rows on both campuses', (name, countKey) => {
    const docs = snapshot()[name];
    expect(docs).toBeDefined();
    for (const key of CAMPUS_KEYS) {
      expect(COUNTS[key][countKey]).toBeGreaterThan(0);
    }
    expect(docs).toHaveLength(CAMPUS_KEYS.reduce((sum, key) => sum + COUNTS[key][countKey], 0));
  });

  it('keeps nested identifiers and schema-default dates stable across wall clocks', () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const first = snapshot();
    expect(Object.keys(first)).toHaveLength(Object.keys(COLLECTIONS).length);
    jest.setSystemTime(new Date('2040-01-01T00:00:00Z'));
    expect(snapshot()).toEqual(first);
  });
});
