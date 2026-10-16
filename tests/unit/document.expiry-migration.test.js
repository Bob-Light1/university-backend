'use strict';

/** @file document.expiry-migration.test.js
 * @description Targeted DDL, dry-run safety, replay and failure handling for GED TTL retirement.
 */
const { retireDocumentExpiry } = require('../../scripts/retire-document-expiry');
const legacy = { name: 'custom_expiry', key: { expiresAt: 1 }, expireAfterSeconds: 0 };
const normal = { name: 'normal_expiry_lookup', key: { expiresAt: 1 } };
const identity = { name: '_id_', key: { _id: 1 } };

/** Model native collection metadata without mocking a business model's deletion convention. */
function collectionWith(indexes) {
  const collection = { collectionName: 'documents' };
  collection.listIndexes = jest.fn(() => ({ toArray: jest.fn(async () => indexes) }));
  collection.dropIndex = jest.fn(async name => { indexes = indexes.filter(index => index.name !== name); });
  return collection;
}

describe('retireDocumentExpiry', () => {
  test('default dry run lists custom-named legacy TTL without writing', async () => {
    const collection = collectionWith([identity, legacy, normal]);
    expect(await retireDocumentExpiry({ collection })).toEqual({
      apply: false, collection: 'documents', planned: [legacy.name], dropped: [],
    });
    expect(collection.dropIndex).not.toHaveBeenCalled();
  });

  test('apply drops only legacy TTL and is idempotent', async () => {
    const collection = collectionWith([identity, legacy, normal]);
    expect((await retireDocumentExpiry({ collection, apply: true })).dropped).toEqual([legacy.name]);
    expect(collection.dropIndex.mock.calls).toEqual([[legacy.name]]);
    expect((await retireDocumentExpiry({ collection, apply: true })).planned).toEqual([]);
    expect(await collection.listIndexes().toArray()).toEqual([identity, normal]);
  });

  test('nonzero TTL settings on the retired key are also removed', async () => {
    const collection = collectionWith([{ ...legacy, expireAfterSeconds: 3600 }]);
    await retireDocumentExpiry({ collection, apply: true });
    expect(collection.dropIndex).toHaveBeenCalledWith(legacy.name);
  });

  test.each([
    { name: 'other_date', key: { retentionUntil: 1 }, expireAfterSeconds: 0 },
    { name: 'compound', key: { expiresAt: 1, campusId: 1 }, expireAfterSeconds: 0 },
  ])('unexpected TTL index $name refuses before any drop', async unexpected => {
    const collection = collectionWith([legacy, unexpected]);
    await expect(retireDocumentExpiry({ collection, apply: true })).rejects.toThrow('Unexpected');
    expect(collection.dropIndex).not.toHaveBeenCalled();
  });

  test.each([false, true])('missing collection is a no-op (apply=%s)', async apply => {
    const collection = collectionWith([]);
    collection.listIndexes.mockImplementation(() => ({ toArray: async () => { throw { code: 26 }; } }));
    expect((await retireDocumentExpiry({ collection, apply })).planned).toEqual([]);
    expect(collection.dropIndex).not.toHaveBeenCalled();
  });

  test('metadata access errors propagate without mutation', async () => {
    const collection = collectionWith([legacy]);
    collection.listIndexes.mockImplementation(() => ({ toArray: async () => { throw new Error('denied'); } }));
    await expect(retireDocumentExpiry({ collection, apply: true })).rejects.toThrow('denied');
    expect(collection.dropIndex).not.toHaveBeenCalled();
  });

  test('drop failures propagate rather than claiming completion', async () => {
    const collection = collectionWith([legacy]);
    collection.dropIndex.mockRejectedValue(new Error('DDL denied'));
    await expect(retireDocumentExpiry({ collection, apply: true })).rejects.toThrow('DDL denied');
  });

  test('concurrent retirement is accepted only after rechecking metadata', async () => {
    const collection = collectionWith([legacy]);
    collection.dropIndex.mockImplementation(async () => {
      collection.listIndexes.mockImplementation(() => ({ toArray: async () => [identity] }));
      throw { code: 27 };
    });
    expect((await retireDocumentExpiry({ collection, apply: true })).dropped).toEqual([]);
    expect(collection.listIndexes).toHaveBeenCalledTimes(2);
  });

  test('a recreated TTL index fails the completion check', async () => {
    const collection = collectionWith([legacy]);
    collection.dropIndex.mockResolvedValue();
    await expect(retireDocumentExpiry({ collection, apply: true })).rejects.toThrow('remains');
  });
});
