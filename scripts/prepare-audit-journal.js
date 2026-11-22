'use strict';

/**
 * @file prepare-audit-journal.js
 * @description Inspect journal indexes by default; --apply adds only missing indexes.
 * No source eligibility rewrite, ledger replay, index removal or event mutation.
 */
const mongoose = require('mongoose');
const { isDeepStrictEqual } = require('node:util');
const AuditEvent = require('../modules/audit/models/audit-event.model');

/** Read installed indexes without creating a namespace during inspection. */
async function listIndexes(collection) {
  try { return await collection.listIndexes().toArray(); }
  catch (error) { if (error.code === 26) return []; throw error; }
}

/** Reject unexpected expiry and conflicting definitions before any index mutation. */
function planIndexes(installed) {
  if (installed.some(index => index.expireAfterSeconds !== undefined)) throw new Error('Unexpected journal TTL; review before preparation.');
  const missing = [];
  for (const [key, options] of AuditEvent.schema.indexes()) {
    const matches = installed.filter(index => index.name === options.name || isDeepStrictEqual(Object.entries(index.key), Object.entries(key)));
    if (matches.some(index => !isDeepStrictEqual(Object.entries(index.key), Object.entries(key)) ||
      Boolean(index.unique) !== Boolean(options.unique) || index.sparse || index.partialFilterExpression || index.collation || index.hidden)) {
      throw new Error('Conflicting journal index; review before preparation.');
    }
    if (!matches.length) missing.push({ key, ...options });
  }
  return missing;
}

/**
 * Prepare only the new journal collection/indexes; dry-run is read-only and repeatable.
 * @param {{ apply?: boolean, collection?: object }} [options]
 * @returns {Promise<object>} Counts and index names only; no event or source data.
 */
async function prepareAuditJournal({ apply = false, collection = AuditEvent.collection } = {}) {
  const planned = planIndexes(await listIndexes(collection));
  if (apply && planned.length) {
    await collection.createIndexes(planned.map(({ background: _background, ...index }) => index));
    if (planIndexes(await listIndexes(collection)).length) throw new Error('Journal indexes remain incomplete.');
  }
  return {
    apply, collection: collection.collectionName, planned: planned.map(index => index.name),
    sourceEligibilityPrepared: false, historicalCoverageCertified: false,
  };
}

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  (async () => {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--apply')) throw new Error('Usage: prepare-audit-journal.js [--apply]');
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
    await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
    console.log(JSON.stringify(await prepareAuditJournal({ apply: args.includes('--apply') })));
  })().catch(() => { console.error('Journal preparation failed; inspect target indexes and configuration privately.'); process.exitCode = 1; })
    .finally(() => mongoose.disconnect());
}

module.exports = { prepareAuditJournal };
