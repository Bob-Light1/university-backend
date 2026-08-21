'use strict';

/**
 * @file seed.js
 * @description Entry point of the deterministic fixture (CH-0): guard → purge →
 * build → verify → export.
 *
 * Usage:
 *   npm run seed:test                # purge + build + verify
 *   npm run seed:test -- --verify    # verify an existing database, build nothing
 *   npm run seed:test -- --print     # print the account table after seeding
 *   npm run seed:test -- --ephemeral # run against a throwaway in-memory replica set
 *
 * Target database: `MONGODB_TEST_URI`, defaulting to a local `erp_test_fixture`.
 * The guard in `seed.config.js` refuses anything that is not a loopback test
 * database — this script purges before it builds, and a purge is not recoverable.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const {
  ANCHOR_DATE,
  BCRYPT_ROUNDS,
  TEST_PASSWORD,
  assertTestDatabaseUri,
  resolveTestUri,
} = require('./seed.config');
const { at, stamps, bcryptSalt } = require('./ids');
const { loadAllModels, model } = require('./models');
const { softDeletePatch } = require('../../shared/utils/soft-delete');
const { verify } = require('./verify');
const { writeAccounts, formatAccounts } = require('./exports');

const campusBuilder = require('./builders/campus.builder');
const academicsBuilder = require('./builders/academics.builder');
const actorsBuilder = require('./builders/actors.builder');
const recordsBuilder = require('./builders/records.builder');
const financeBuilder = require('./builders/finance.builder');
const contentBuilder = require('./builders/content.builder');

/**
 * Builds the context every builder shares: the frozen clock, the single password
 * hash, and the deletion-patch helper that keeps R7 enforceable inside the seed.
 *
 * @param {string} passwordHash
 * @returns {Object}
 */
const createContext = (passwordHash) => ({
  passwordHash,
  at,
  stamps,
  anchorYear: ANCHOR_DATE.getUTCFullYear(),
  /**
   * Deletion markers are derived from the model, never written as literals: the
   * three conventions fail silently when mixed up (CLAUDE.md §5.1).
   *
   * @param {string} modelName
   * @param {Date} deletedAt
   * @returns {Object}
   */
  softDelete: (modelName, deletedAt) => softDeletePatch(model(modelName), { at: deletedAt }),
});

/**
 * Drops every collection of the target database.
 *
 * Dropping rather than deleting matters for `counters`: a purge that spares it
 * leaves auto-incremented references drifting from one run to the next, and the
 * danger-zone confirmation phrases are built on those references (§4.8).
 *
 * @param {import('mongoose').Connection} connection
 * @returns {Promise<number>} Number of collections dropped.
 */
const purge = async (connection) => {
  const collections = await connection.db.listCollections().toArray();

  await Promise.all(collections.map((c) => connection.db.dropCollection(c.name)));

  return collections.length;
};

/**
 * Inserts one builder group.
 *
 * `timestamps: false` is the whole point: `{ timestamps: true }` is mandatory on
 * every schema (CLAUDE.md §5) and would overwrite the seeded `createdAt` with the
 * wall clock, breaking every "created on" column and every `createdAt` sort the
 * layers above capture (§4.4). Validation stays ON — a fixture that violates a
 * schema is a fixture that will fail somewhere less legible later.
 *
 * @param {{ model: string, docs: Object[] }} group
 * @returns {Promise<number>} Number of documents inserted.
 */
const insertGroup = async ({ model: name, docs }) => {
  if (docs.length === 0) return 0;

  await model(name).insertMany(docs, { timestamps: false, ordered: true });

  return docs.length;
};

/**
 * Realigns the auto-increment counters the application reads through
 * `shared/db/counter.model.js`, so the first row a test creates continues the
 * fixture's numbering instead of colliding with it.
 *
 * @param {Object} ctx
 * @returns {Promise<void>}
 */
const realignCounters = async (ctx) => {
  const Counter = model('Counter');
  const year = ctx.anchorYear;

  await Counter.bulkWrite([
    {
      updateOne: {
        filter: { _id: `result_${year}` },
        update: { $set: { seq: ctx.resultCount } },
        upsert: true,
      },
    },
    {
      updateOne: {
        filter: { _id: `parent_ref_${year}` },
        update: { $set: { seq: ctx.parentCount } },
        upsert: true,
      },
    },
  ]);
};

/**
 * Rebuilds the indexes declared by the seeded models. The purge dropped them
 * with their collections, and the unique constraints are part of what the layers
 * above exercise (duplicate-key handling is a documented response path).
 *
 * @param {string[]} names
 * @returns {Promise<void>}
 */
const syncIndexes = async (names) => {
  await Promise.all(names.map((name) => model(name).createIndexes()));
};

/**
 * Assembles the whole dataset, in dependency order.
 *
 * Order is load-bearing twice, both times because a schema reads the database
 * back during validation: teachers before classes (`Class.pre('validate')` checks
 * the class manager's campus) and students before parents
 * (`Parent.pre('validate')` checks each child's campus).
 *
 * @param {Object} ctx
 * @returns {Array<{ model: string, docs: Object[] }>}
 */
const buildAll = (ctx) => [
  ...campusBuilder.build(ctx),
  ...academicsBuilder.buildFoundation(ctx),
  ...actorsBuilder.build(ctx),
  ...academicsBuilder.buildTeaching(ctx),
  ...recordsBuilder.build(ctx),
  ...financeBuilder.build(ctx),
  ...contentBuilder.build(ctx),
];

/**
 * @param {Object} [options]
 * @param {boolean} [options.print=false]
 * @returns {Promise<{ inserted: number, groups: number, durationMs: number }>}
 */
const seed = async ({ print = false } = {}) => {
  const startedAt = Date.now();
  const connection = mongoose.connection;

  loadAllModels();

  const droppedCollections = await purge(connection);
  console.log(`  purged ${droppedCollections} collection(s)`);

  // Hashed ONCE for every account: bcrypt at 12 rounds costs 250-400 ms, and the
  // password is common by construction (§4.4). The salt is derived rather than
  // drawn, so the hash — and therefore every account document — is identical
  // from one run to the next.
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, bcryptSalt(BCRYPT_ROUNDS));
  const ctx = createContext(passwordHash);

  const groups = buildAll(ctx);
  let inserted = 0;

  for (const group of groups) {
    inserted += await insertGroup(group);
  }

  await realignCounters(ctx);
  await syncIndexes(groups.map((g) => g.model));

  console.log(`  inserted ${inserted} documents across ${groups.length} collections`);

  await verify();
  console.log('  verification passed');

  const { file, catalogue } = writeAccounts(ctx);
  console.log(`  wrote ${file}`);

  if (print) console.log(`\n${formatAccounts(catalogue)}`);

  return { inserted, groups: groups.length, durationMs: Date.now() - startedAt };
};

/**
 * Picks a data directory for the ephemeral server, preferring a real tmpfs.
 *
 * This is not a micro-optimisation. `mongodb-memory-server` stores its data on
 * the ordinary filesystem despite its name, and every index build there costs a
 * synchronous flush: on this machine, creating the ~180 declared indexes took
 * **250 s from disk and under 3 s from `/dev/shm`**. The 60 s budget of §4.7 is
 * unreachable on disk and comfortable in memory, so the directory is chosen, not
 * inherited.
 *
 * @returns {{ dbPath: string|undefined, cleanup: () => void }}
 */
const createEphemeralDataDir = () => {
  const shm = '/dev/shm';

  if (!fs.existsSync(shm)) return { dbPath: undefined, cleanup: () => {} };

  const dbPath = fs.mkdtempSync(path.join(shm, 'erp-fixture-'));

  return {
    dbPath,
    cleanup: () => fs.rmSync(dbPath, { recursive: true, force: true }),
  };
};

/**
 * Boots a throwaway in-memory replica set — a replica SET, not a standalone,
 * because the hard-delete cascades run in transactions and those need one
 * (§6.5). Used by `--ephemeral` and, later, by the CH-2 `globalSetup`.
 *
 * @returns {Promise<{ uri: string, stop: () => Promise<void> }>}
 */
const startEphemeralDatabase = async () => {
  // Required lazily: `mongodb-memory-server` is a dev dependency, and the seed
  // must stay runnable against a real database without it being installed.
  const { MongoMemoryReplSet } = require('mongodb-memory-server');
  const { dbPath, cleanup } = createEphemeralDataDir();
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ launchTimeout: 60000, ...(dbPath ? { dbPath } : {}) }],
  });

  return {
    uri: replSet.getUri('erp_test_fixture'),
    dbPath: dbPath || os.tmpdir(),
    stop: async () => {
      await replSet.stop();
      cleanup();
    },
  };
};

/**
 * CLI entry point.
 *
 * @returns {Promise<void>}
 */
const main = async () => {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes('--verify');
  const print = args.includes('--print');
  const ephemeral = args.includes('--ephemeral');

  let ephemeralHandle = null;
  let uri = resolveTestUri();

  if (ephemeral) {
    console.log('› starting ephemeral in-memory replica set…');
    ephemeralHandle = await startEphemeralDatabase();
    uri = ephemeralHandle.uri;
  }

  const target = assertTestDatabaseUri(uri);
  console.log(`› target database: ${target.dbName} on ${target.hosts.join(', ')}`);

  // Collection and index creation are driven explicitly, after the inserts.
  // Left on, Mongoose creates a collection for every compiled model as soon as
  // it connects: the purge would then race what Mongoose is building, and the
  // database would end a run holding ~25 empty collections that a second run
  // does not recreate — two seeds, two different databases.
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });

  try {
    if (verifyOnly) {
      loadAllModels();
      const report = await verify();
      console.log(`✓ fixture verified — ${report.checks.length} checks passed`);
    } else {
      const { inserted, durationMs } = await seed({ print });
      console.log(`✓ fixture ready — ${inserted} documents in ${(durationMs / 1000).toFixed(1)}s`);
    }
  } finally {
    await mongoose.disconnect();
    if (ephemeralHandle) await ephemeralHandle.stop();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { seed, purge, buildAll, createContext, startEphemeralDatabase, main };
