'use strict';

/**
 * @file retire-document-expiry.js
 * @description Retire only legacy business-document expiry indexes; dry run by default.
 * Usage: node scripts/retire-document-expiry.js [--apply]
 * Does not rewrite documents or touch operational DocumentShare TTL indexes.
 */
const mongoose = require('mongoose');
const Document = require('../modules/document/models/document.model');

/** List installed indexes without creating a missing collection. */
async function listIndexes(collection) {
  try {
    return await collection.listIndexes().toArray();
  } catch (error) {
    if (error.code === 26) return []; // NamespaceNotFound: a new installation has nothing to retire.
    throw error;
  }
}

/**
 * Inspect or retire the legacy TTL index, including installations with a custom name.
 * Fail before mutation if the business collection has an unexpected TTL key pattern.
 * @param {object} [options]
 * @param {boolean} [options.apply=false] Explicitly allow targeted index removal.
 * @param {object} [options.collection] Collection handle; defaults to Document's actual collection.
 * @returns {Promise<object>} Index names only; no business records or credentials.
 */
async function retireDocumentExpiry({ apply = false, collection = Document.collection } = {}) {
  const indexes = await listIndexes(collection);
  const ttlIndexes = indexes.filter(index => index.expireAfterSeconds !== undefined);
  if (ttlIndexes.some(index => Object.keys(index.key).length !== 1 || index.key.expiresAt !== 1)) {
    throw new Error('Unexpected Document TTL index; review its key pattern before migration.');
  }
  const planned = ttlIndexes.map(index => index.name);
  const dropped = [];
  if (apply) {
    for (const name of planned) {
      try {
        await collection.dropIndex(name);
        dropped.push(name);
      } catch (error) {
        if (error.code !== 27) throw error; // IndexNotFound: another operator already removed it.
      }
    }
    const remaining = await listIndexes(collection);
    if (remaining.some(index => index.expireAfterSeconds !== undefined)) {
      throw new Error('Document TTL index remains after migration; stop old schema instances and retry.');
    }
  }
  return { apply, collection: collection.collectionName, planned, dropped };
}

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  (async () => {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--apply')) throw new Error('Usage: retire-document-expiry.js [--apply]');
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
    await mongoose.connect(process.env.MONGODB_URI, {
      autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000,
    });
    console.log(JSON.stringify(await retireDocumentExpiry({ apply: args.includes('--apply') })));
  })().catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => mongoose.disconnect());
}

module.exports = { retireDocumentExpiry };
