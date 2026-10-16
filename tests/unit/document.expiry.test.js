'use strict';

/** @file document.expiry.test.js
 * @description Business documents must never be deleted by MongoDB TTL cleanup.
 */
const Document = require('../../modules/document/models/document.model');
const DocumentShare = require('../../modules/document/models/document.share.model');

describe('GED business-document expiry policy', () => {
  test('the business collection declares no TTL index on any field', () => {
    expect(Document.schema.indexes().filter(([, options]) =>
      options.expireAfterSeconds !== undefined)).toEqual([]);
  });

  test('strict document construction discards the retired expiry field', () => {
    const doc = new Document({ title: 'Expiry regression', expiresAt: new Date(0) });
    expect(Document.schema.path('expiresAt')).toBeUndefined();
    expect(doc.toObject()).not.toHaveProperty('expiresAt');
  });

  test('temporary share capabilities retain their independent expiry policy', () => {
    expect(DocumentShare.schema.indexes().filter(([, options]) =>
      options.expireAfterSeconds !== undefined))
      .toEqual([[{ expiresAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })]]);
  });
});
