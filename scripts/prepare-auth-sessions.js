'use strict';
/** @file prepare-auth-sessions.js
 * @description Expand-only session collection/index preparation; dry run by default.
 * Usage: node scripts/prepare-auth-sessions.js [--apply]
 * Never removes indexes, rewrites accounts or converts legacy access tokens.
 */
const mongoose = require('mongoose');
const Session = require('../modules/account/session.model');
const LoginState = require('../modules/account/login-state.model');

/** Prepare only the two operational collections, retaining every existing index. */
async function prepareAuthSessions({ apply = false } = {}) {
  const report = [];
  for (const Model of [Session, LoginState]) {
    const indexes = Model.schema.indexes();
    report.push({ model: Model.modelName, indexes: indexes.length });
    if (apply) {
      await Model.createCollection();
      await Model.createIndexes();
    }
  }
  return report;
}

if (require.main === module) {
  require('dotenv').config();
  const apply = process.argv.includes('--apply');
  (async () => {
    if (apply) {
      if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
      await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });
    }
    console.log(JSON.stringify({ apply, collections: await prepareAuthSessions({ apply }) }));
  })().catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => mongoose.disconnect());
}
module.exports = { prepareAuthSessions };
