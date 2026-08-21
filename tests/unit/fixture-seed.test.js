'use strict';

/**
 * @file fixture-seed.test.js
 * @description Unit coverage for the deterministic fixture (CH-0) — the parts
 * that need no database: the destruction guard, and the stability of the derived
 * identifiers and clock.
 *
 * The guard is tested here rather than in the fixture's own self-check because it
 * is the one thing that must never be discovered broken at run time: a seed that
 * purges the wrong database is the worst incident this apparatus can cause
 * (QA_TEST_STRATEGY.md §4.4).
 */

const {
  assertTestDatabaseUri,
  parseMongoUri,
  resolveTestUri,
  DEFAULT_TEST_URI,
  COUNTS,
} = require('../fixtures/seed.config');
const { oid, oids, token, at, stamps, bcryptSalt } = require('../fixtures/ids');
const { ANCHOR_DATE } = require('../fixtures/seed.config');

describe('fixture destruction guard', () => {
  const accepted = [
    ['a named local test database', 'mongodb://127.0.0.1:27017/erp_test_fixture'],
    ['localhost rather than the loopback literal', 'mongodb://localhost:27017/qa_snapshot'],
    ['an ephemeral port', 'mongodb://127.0.0.1:41999/erp_test_fixture'],
    ['a replica-set query string', 'mongodb://127.0.0.1:41999/erp_test_fixture?replicaSet=testset'],
    [
      'the UUID database mongodb-memory-server generates when unnamed',
      'mongodb://127.0.0.1:41999/9b5f7a2c-1c31-4f0e-8f4a-6d2f5b7e1a44',
    ],
  ];

  it.each(accepted)('accepts %s', (_label, uri) => {
    expect(() => assertTestDatabaseUri(uri, {})).not.toThrow();
  });

  const refused = [
    ['a remote Atlas cluster', 'mongodb+srv://user:pw@cluster.mongodb.net/university'],
    ['a routable host', 'mongodb://10.0.0.5:27017/erp_test_fixture'],
    ['a production-looking database name', 'mongodb://127.0.0.1:27017/university'],
    ['a connection string with no database', 'mongodb://127.0.0.1:27017'],
    ['a replica set whose second member is remote', 'mongodb://127.0.0.1:27017,db.prod:27017/erp_test'],
    ['anything that is not a connection string', 'not-a-uri'],
  ];

  it.each(refused)('refuses %s', (_label, uri) => {
    expect(() => assertTestDatabaseUri(uri, {})).toThrow(/Refusing to seed/);
  });

  it('refuses even a valid test URI when NODE_ENV is production', () => {
    expect(() => assertTestDatabaseUri(DEFAULT_TEST_URI, { NODE_ENV: 'production' }))
      .toThrow(/NODE_ENV/);
  });

  it('parses the comma-separated host list of a replica-set URI', () => {
    expect(parseMongoUri('mongodb://127.0.0.1:1,127.0.0.1:2/erp_test?replicaSet=rs')).toEqual({
      protocol: 'mongodb',
      hosts: ['127.0.0.1:1', '127.0.0.1:2'],
      dbName: 'erp_test',
    });
  });

  it('falls back to the local test database when no URI is configured', () => {
    expect(resolveTestUri({})).toBe(DEFAULT_TEST_URI);
  });
});

describe('deterministic identifiers', () => {
  it('derives the same ObjectId for the same business key', () => {
    expect(String(oid('student:A:001'))).toBe(String(oid('student:A:001')));
  });

  it('derives different ObjectIds for different keys', () => {
    expect(String(oid('student:A:001'))).not.toBe(String(oid('student:A:002')));
  });

  it('derives a sequence sharing a prefix', () => {
    const [first, second] = oids('student:A', 2);

    expect(String(first)).toBe(String(oid('student:A:001')));
    expect(String(second)).toBe(String(oid('student:A:002')));
  });

  it('derives stable hex tokens', () => {
    expect(token('result:A:001')).toBe(token('result:A:001'));
    expect(token('result:A:001')).toHaveLength(32);
  });

  it('produces a bcrypt salt the library accepts, stable across calls', () => {
    expect(bcryptSalt(12)).toMatch(/^\$2b\$12\$[./A-Za-z0-9]{22}$/);
    expect(bcryptSalt(12)).toBe(bcryptSalt(12));
  });
});

describe('frozen clock', () => {
  it('offsets from the anchor rather than from the wall clock', () => {
    expect(at(0).toISOString()).toBe(ANCHOR_DATE.toISOString());
    expect(at(-1).getTime()).toBe(ANCHOR_DATE.getTime() - 24 * 60 * 60 * 1000);
  });

  it('writes both timestamps explicitly, since every schema sets them itself', () => {
    const written = stamps(10);

    expect(written.createdAt.toISOString()).toBe(at(-10).toISOString());
    expect(written.updatedAt.toISOString()).toBe(at(-10).toISOString());
  });
});

describe('declared volumes', () => {
  it('gives campus A more rows than campus B, so an isolation leak is visible', () => {
    expect(COUNTS.A.students).toBeGreaterThan(COUNTS.B.students);
    expect(COUNTS.A.results).toBeGreaterThan(COUNTS.B.results);
  });

  it('declares two sign-in partners per campus — family C′ has no target otherwise', () => {
    expect(COUNTS.A.partnerAccounts).toBe(2);
    expect(COUNTS.B.partnerAccounts).toBe(2);
    expect(COUNTS.A.partners).toBeGreaterThanOrEqual(COUNTS.A.partnerAccounts);
  });

  it('declares the three deletion traps of §4.3', () => {
    expect(COUNTS.A.resultsDeleted).toBeGreaterThan(0);
    expect(COUNTS.A.resultsArchivedAlive).toBeGreaterThan(0);
    expect(COUNTS.A.announcementsExpiredAlive).toBeGreaterThan(0);
    expect(COUNTS.A.documentsDeleted).toBeGreaterThan(0);
  });
});
