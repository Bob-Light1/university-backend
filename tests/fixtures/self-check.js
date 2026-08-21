'use strict';

/**
 * @file self-check.js
 * @description Executable proof of the CH-0 definition of done (§4.7) — the parts
 * that need a real database and therefore cannot live in the `unit` Jest project.
 *
 *   npm run seed:test:self-check
 *
 * It boots one throwaway replica set and checks, in order:
 *   1. a seed on a blank database completes inside the 60 s budget;
 *   2. two consecutive seeds produce a byte-identical database — same ObjectIds,
 *      same timestamps, same password hashes;
 *   3. `verify.js` FAILS loudly when a single expected row is missing (a verifier
 *      that cannot fail proves nothing about the fixture it blesses);
 *   4. `.generated/accounts.json` covers the nine signed-in roles, with two
 *      PARTNER accounts per campus;
 *   5. every one of those nine roles actually signs in against the real app —
 *      the export is only worth what the login endpoints accept from it.
 *
 * Not part of `npm test`: it needs a mongod binary, which the unit suite
 * deliberately does not.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');
const request = require('supertest');

const { seed, startEphemeralDatabase } = require('./seed');
const { verify } = require('./verify');
const { loadAllModels, model } = require('./models');
const { readAccounts } = require('./exports');
const { COUNTS, CAMPUS_KEYS } = require('./seed.config');

/** Budget of §4.7, in milliseconds. */
const SEED_BUDGET_MS = 60000;

/** The nine signed-in roles of the platform (§1.2). */
const ROLES = Object.freeze([
  'ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER',
  'STUDENT', 'PARENT', 'MENTOR', 'STAFF', 'PARTNER',
]);

const results = [];

/**
 * @param {string} label
 * @param {boolean} ok
 * @param {string} [detail]
 */
const record = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

/**
 * Hashes the whole database: collection names, and every document of each,
 * sorted by `_id`. Two runs that differ anywhere differ here.
 *
 * @param {import('mongoose').Connection} connection
 * @returns {Promise<string>}
 */
const digestDatabase = async (connection) => {
  const names = (await connection.db.listCollections().toArray()).map((c) => c.name).sort();
  const hash = crypto.createHash('sha256');

  for (const name of names) {
    const docs = await connection.db.collection(name).find({}).sort({ _id: 1 }).toArray();
    hash.update(name).update(JSON.stringify(docs));
  }

  return hash.digest('hex');
};

/**
 * @returns {Promise<void>}
 */
const main = async () => {
  console.log('› booting throwaway replica set…');
  const handle = await startEphemeralDatabase();

  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(handle.uri);
  loadAllModels();

  try {
    console.log('\n› 1. first seed on a blank database');
    const first = await seed({});
    record(
      `seed completes within ${SEED_BUDGET_MS / 1000}s`,
      first.durationMs < SEED_BUDGET_MS,
      `${(first.durationMs / 1000).toFixed(1)}s for ${first.inserted} documents`
    );

    const firstDigest = await digestDatabase(mongoose.connection);

    console.log('\n› 2. second seed on the same database');
    const second = await seed({});
    const secondDigest = await digestDatabase(mongoose.connection);

    record('two consecutive runs produce an identical database', firstDigest === secondDigest,
      firstDigest === secondDigest ? firstDigest.slice(0, 16) : `${firstDigest.slice(0, 16)} ≠ ${secondDigest.slice(0, 16)}`);
    record('second run inserts the same number of documents', first.inserted === second.inserted,
      `${first.inserted} vs ${second.inserted}`);

    console.log('\n› 3. the verifier fails on a missing row');
    const Student = model('Student');
    const victim = await Student.findOne({ matricule: 'STU-A-002' }).lean();
    await Student.deleteOne({ _id: victim._id });

    let threw = false;
    try {
      await verify({ silent: true });
    } catch (error) {
      threw = /verification failed/i.test(error.message);
    }
    record('verify() rejects a database missing one student', threw);

    await Student.collection.insertOne(victim);

    console.log('\n› 4. exported account catalogue');
    const catalogue = readAccounts();
    const exported = new Set(Object.values(catalogue.accounts).flat().map((a) => a.role));

    record('the nine signed-in roles are exported', ROLES.every((role) => exported.has(role)),
      [...exported].sort().join(', '));

    for (const campusKey of CAMPUS_KEYS) {
      const partners = catalogue.accounts[`campus${campusKey}`].filter((a) => a.role === 'PARTNER');
      record(
        `campus ${campusKey} exports ${COUNTS[campusKey].partnerAccounts} PARTNER accounts with leads and commissions`,
        partners.length === COUNTS[campusKey].partnerAccounts
          && partners.every((p) => p.leads.length > 0 && p.commissions.length > 0)
      );
    }

    console.log('\n› 5. every role signs in against the real app');
    // Each role authenticates on its own endpoint and on its own login field —
    // they differ, and a catalogue that gets either wrong yields a 401 that reads
    // like a broken fixture. One account per role, so no login limiter trips.
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'fixture-self-check-secret';
    const app = require('../../app');
    const attempted = new Set();

    for (const account of Object.values(catalogue.accounts).flat()) {
      if (attempted.has(account.role)) continue;
      attempted.add(account.role);

      const [, path] = account.endpoint.split(' ');
      const response = await request(app)
        .post(path)
        .send({ [account.loginField]: account.login, password: account.password });

      record(
        `${account.role} signs in on ${path}`,
        response.status === 200 && Boolean(response.body?.data?.token)
      );
    }
  } finally {
    await mongoose.disconnect();
    await handle.stop();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '✓' : '✗'} ${results.length - failed.length}/${results.length} checks passed`);

  if (failed.length > 0) process.exitCode = 1;
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`✗ ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, digestDatabase };
