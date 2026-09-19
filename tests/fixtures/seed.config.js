'use strict';

/**
 * @file seed.config.js
 * @description Single source of truth for the deterministic test fixture (CH-0):
 * anchor date, hash seed, expected volumes, test credentials and the destruction
 * guard that decides which databases the seed is allowed to touch.
 *
 * Every number the builders produce and `verify.js` asserts comes from `COUNTS`
 * below — the two must never restate a volume independently, or a fixture drift
 * would make the verifier agree with the bug.
 */

/**
 * Namespace mixed into every derived ObjectId. Changing it renews the whole
 * identifier space, so CH-4 reference screenshots break on purpose rather than
 * silently pointing at other rows.
 */
const SEED_NAMESPACE = 'erp-academic-fixture-v1';

/**
 * Anchor for every date in the fixture. No builder may call `new Date()`:
 * "due soon" and "overdue" screens must render identically in six months
 * (CH-4/CH-5 reference captures depend on it).
 */
const ANCHOR_DATE = new Date('2026-06-15T09:00:00.000Z');

/** Academic year label used across results, schedules, exams and fees. */
const ACADEMIC_YEAR = '2025-2026';

/**
 * Shared clear-text password for every seeded account. Hashed ONCE per run and
 * reused (bcrypt at 12 rounds costs 250-400 ms per call — hashing ~60 accounts
 * one by one would eat a third of the 60 s budget of §4.7).
 * It is a test credential by construction and must never reach a production env.
 */
const TEST_PASSWORD = 'FixtureP@ss2026!';

/** CLAUDE.md §8 — the fixture hashes exactly like the application does. */
const BCRYPT_ROUNDS = 12;

/** Campus keys used to derive identifiers; also the labels shown by `--print`. */
const CAMPUS_KEYS = Object.freeze(['A', 'B']);

/**
 * Expected volumes, per QA_TEST_STRATEGY.md §4.3. `verify.js` reads THIS object,
 * never its own literals.
 */
const COUNTS = Object.freeze({
  A: Object.freeze({
    teachers: 3,            // incl. 1 archived
    teachersArchived: 1,
    students: 12,           // incl. 2 archived, 2 pending, 1 suspended
    studentsArchived: 2,
    studentsPending: 2,
    studentsSuspended: 1,
    parents: 6,             // incl. 1 linked to 2 children
    mentors: 2,
    staff: 2,
    staffRoles: 2,
    classes: 4,             // incl. 1 archived
    classesArchived: 1,
    departments: 2,
    subjects: 8,            // incl. 1 with coefficient 0
    partners: 3,            // the first 2 own a sign-in account
    partnerAccounts: 2,
    partnerLeads: 6,        // split across the 2 sign-in partners
    partnerCommissions: 4,
    results: 40,            // incl. 5 soft-deleted and 3 ARCHIVED-but-live
    resultsDeleted: 5,
    resultsArchivedAlive: 3,
    documents: 10,          // incl. 3 soft-deleted keeping status PUBLISHED
    documentsDeleted: 3,
    announcements: 6,       // incl. 2 soft-deleted and 2 expired-but-live
    announcementsDeleted: 2,
    announcementsExpiredAlive: 2,
    incomes: 8,
    incomesDeleted: 2,
    expenses: 6,
    expensesDeleted: 2,
    studentFees: 12,
    studentFeesDeleted: 2,
    studentFeesOverdue: 3,
    studentFeesDueSoon: 3,   // one per pre-due kind: J-7, J-3, due day
    feePayments: 3,
    examSessions: 2,
    examEnrollments: 4,     // the roster of class A1, one full cycle
    examSubmissions: 3,     // one enrolled student sat no paper
    examGradings: 3,
    scheduleSlots: 5,       // one teaching week
    scheduleSlotsDeleted: 1,
  }),
  B: Object.freeze({
    teachers: 2,
    teachersArchived: 0,
    students: 8,
    studentsArchived: 0,
    studentsPending: 0,
    studentsSuspended: 0,
    parents: 4,
    mentors: 1,
    staff: 1,
    staffRoles: 1,
    classes: 2,
    classesArchived: 0,
    departments: 1,
    subjects: 5,
    partners: 2,
    partnerAccounts: 2,
    partnerLeads: 3,
    partnerCommissions: 2,
    results: 20,
    resultsDeleted: 0,
    resultsArchivedAlive: 0,
    documents: 5,
    documentsDeleted: 0,
    announcements: 3,
    announcementsDeleted: 0,
    announcementsExpiredAlive: 0,
    incomes: 4,
    incomesDeleted: 0,
    expenses: 3,
    expensesDeleted: 0,
    studentFees: 8,
    studentFeesDeleted: 0,
    studentFeesOverdue: 1,
    studentFeesDueSoon: 0,   // the pre-due cadence is materialized on campus A only
    feePayments: 2,
    examSessions: 1,
    examEnrollments: 4,
    examSubmissions: 3,
    examGradings: 3,
    scheduleSlots: 5,
    scheduleSlotsDeleted: 1,
  }),
  /**
   * Collections with no campus field at all. `Level` sits here against the
   * per-campus split of §4.3: the schema carries no campus path and the
   * hard-delete registry declares `campusPath: null` for it — see D-21.
   */
  GLOBAL: Object.freeze({
    admins: 2,              // 1 ADMIN + 1 DIRECTOR
    levels: 5,              // 3 + 2 of §4.3, seeded once because Level is global
    courses: 6,
    expenseCategories: 3,
  }),
});

// ── Destruction guard ─────────────────────────────────────────────────────────

/**
 * Database names the seed accepts. Deliberately a prefix family rather than one
 * fixed name: CH-2 hands it an ephemeral database on every run (§6.5), and a
 * guard tailored to a single URI is a guard that gets weakened on day one.
 */
const TEST_DB_NAME_PATTERN = /^(erp[_-])?(test|qa|fixture)[a-z0-9_-]*$/i;

/**
 * `MongoMemoryReplSet` names its database with a bare UUID when the caller does
 * not pick one. Accepted on loopback only — no production database is a bare
 * UUID served from 127.0.0.1.
 */
const EPHEMERAL_DB_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hosts allowed to be purged. Anything routable is refused, port irrelevant. */
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Default target when `MONGODB_TEST_URI` is unset. */
const DEFAULT_TEST_URI = 'mongodb://127.0.0.1:27017/erp_test_fixture';

/**
 * Splits a MongoDB connection string without going through `new URL()`, which
 * chokes on the comma-separated host list of a replica-set URI.
 *
 * @param {string} uri
 * @returns {{ protocol: string, hosts: string[], dbName: string }|null}
 */
const parseMongoUri = (uri) => {
  const match = /^(mongodb(?:\+srv)?):\/\/(?:[^@/]*@)?([^/?]+)(?:\/([^?]*))?(?:\?.*)?$/.exec(
    String(uri || '').trim()
  );

  if (!match) return null;

  return {
    protocol: match[1],
    hosts: match[2].split(',').map((h) => h.trim()).filter(Boolean),
    dbName: decodeURIComponent(match[3] || ''),
  };
};

/**
 * Refuses every database the seed is not explicitly allowed to purge.
 *
 * Fail closed, like `buildCampusFilter()` and the hard-delete registry: an
 * unrecognised URI is refused, never assumed harmless. A seed that purges a
 * production database is the worst incident this whole test apparatus can cause
 * (QA_TEST_STRATEGY.md §4.4).
 *
 * @param {string} uri            Connection string the seed is about to purge.
 * @param {Object} [env]          Environment to read `NODE_ENV` from.
 * @returns {{ uri: string, dbName: string, hosts: string[] }}
 * @throws {Error} When the target is not a recognised test database.
 */
const assertTestDatabaseUri = (uri, env = process.env) => {
  const refuse = (why) => {
    throw new Error(
      `Refusing to seed: ${why}. The fixture purges before it builds, so it only ` +
      `runs against a loopback host whose database is named like a test database ` +
      `(${TEST_DB_NAME_PATTERN}) or is an ephemeral in-memory one. ` +
      `See docs/architecture/QA_TEST_STRATEGY.md §4.4.`
    );
  };

  if (env.NODE_ENV === 'production') refuse('NODE_ENV is "production"');

  const parsed = parseMongoUri(uri);
  if (!parsed) refuse(`"${uri}" is not a MongoDB connection string`);

  if (parsed.protocol !== 'mongodb') {
    refuse(`"${parsed.protocol}://" targets a remote cluster`);
  }

  const routable = parsed.hosts.filter(
    (host) => !LOOPBACK_HOSTS.includes(host.replace(/:\d+$/, ''))
  );
  if (routable.length > 0) refuse(`host "${routable[0]}" is not a loopback address`);

  if (!parsed.dbName) refuse('the connection string carries no database name');

  const named = TEST_DB_NAME_PATTERN.test(parsed.dbName);
  const ephemeral = EPHEMERAL_DB_NAME_PATTERN.test(parsed.dbName);
  if (!named && !ephemeral) refuse(`database "${parsed.dbName}" is not named like a test database`);

  return { uri, dbName: parsed.dbName, hosts: parsed.hosts };
};

/** Resolves the URI the seed should work against. */
const resolveTestUri = (env = process.env) =>
  env.MONGODB_TEST_URI || env.MONGO_TEST_URI || DEFAULT_TEST_URI;

module.exports = {
  SEED_NAMESPACE,
  ANCHOR_DATE,
  ACADEMIC_YEAR,
  TEST_PASSWORD,
  BCRYPT_ROUNDS,
  CAMPUS_KEYS,
  COUNTS,
  DEFAULT_TEST_URI,
  TEST_DB_NAME_PATTERN,
  EPHEMERAL_DB_NAME_PATTERN,
  LOOPBACK_HOSTS,
  parseMongoUri,
  assertTestDatabaseUri,
  resolveTestUri,
};
