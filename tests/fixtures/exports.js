'use strict';

/**
 * @file exports.js
 * @description Writes `tests/fixtures/.generated/accounts.json`, the handover
 * between CH-0 and every layer above it: CH-2 signs its tokens from it, CH-4
 * signs in with it, CH-5 explores with it.
 *
 * It carries the nine signed-in roles — the seven campus-scoped ones on BOTH
 * campuses, including TWO `PARTNER` accounts per campus so family C′ has a
 * partner-to-partner target, plus the two global accounts that belong to no
 * campus (§4.7).
 *
 * The directory is git-ignored: it holds the test password in clear.
 */

const fs = require('fs');
const path = require('path');

const { oid, pad } = require('./ids');
const { COUNTS, CAMPUS_KEYS, TEST_PASSWORD, ANCHOR_DATE, SEED_NAMESPACE } = require('./seed.config');

const GENERATED_DIR = path.join(__dirname, '.generated');
const ACCOUNTS_FILE = path.join(GENERATED_DIR, 'accounts.json');

/**
 * Builds the account catalogue. Every entry states the login field the API
 * actually authenticates on — they differ by role, and guessing produces a 401
 * that reads like a broken fixture.
 *
 * @param {Object} ctx
 * @returns {Object}
 */
const buildCatalogue = (ctx) => {
  const accounts = {
    global: [
      {
        role: 'ADMIN',
        id: String(ctx.adminIds.ADMIN),
        loginField: 'email',
        login: 'admin@fixture.test',
        password: TEST_PASSWORD,
        campusId: null,
        endpoint: 'POST /api/admin/login',
      },
      {
        role: 'DIRECTOR',
        id: String(ctx.adminIds.DIRECTOR),
        loginField: 'email',
        login: 'director@fixture.test',
        password: TEST_PASSWORD,
        campusId: null,
        endpoint: 'POST /api/admin/login',
      },
    ],
  };

  CAMPUS_KEYS.forEach((campusKey) => {
    const campusId = String(ctx.campusIds[campusKey]);
    const lower = campusKey.toLowerCase();

    const entries = [
      {
        role: 'CAMPUS_MANAGER',
        id: campusId,
        loginField: 'email',
        login: `campus.${lower}@fixture.test`,
        password: TEST_PASSWORD,
        campusId,
        endpoint: 'POST /api/campus/login',
      },
      {
        role: 'TEACHER',
        id: String(oid(`teacher:${campusKey}:001`)),
        loginField: 'username',
        login: `teacher.${lower}1`,
        password: TEST_PASSWORD,
        campusId,
        matricule: `TEA-${campusKey}-001`,
        endpoint: 'POST /api/teachers/login',
      },
      {
        role: 'STUDENT',
        id: String(oid(`student:${campusKey}:001`)),
        loginField: 'username',
        login: `student.${lower}1`,
        password: TEST_PASSWORD,
        campusId,
        matricule: `STU-${campusKey}-001`,
        endpoint: 'POST /api/students/login',
      },
      {
        role: 'PARENT',
        id: String(oid(`parent:${campusKey}:001`)),
        loginField: 'username',
        login: `parent.${lower}1`,
        password: TEST_PASSWORD,
        campusId,
        endpoint: 'POST /api/parents/login',
      },
      {
        role: 'MENTOR',
        id: String(oid(`mentor:${campusKey}:001`)),
        loginField: 'username',
        login: `mentor.${lower}1`,
        password: TEST_PASSWORD,
        campusId,
        endpoint: 'POST /api/mentors/login',
      },
      {
        role: 'STAFF',
        id: String(oid(`staff:${campusKey}:001`)),
        loginField: 'username',
        login: `staff.${lower}1`,
        password: TEST_PASSWORD,
        campusId,
        endpoint: 'POST /api/staff/login',
      },
    ];

    // Two PARTNER accounts per campus: with a single one, family C′ would have no
    // second partner to be refused access to, and would pass while testing nothing.
    for (let i = 1; i <= COUNTS[campusKey].partnerAccounts; i += 1) {
      entries.push({
        role: 'PARTNER',
        id: String(oid(`partner:${campusKey}:${pad(i)}`)),
        loginField: 'email',
        login: `partner.${lower}${i}@fixture.test`,
        password: TEST_PASSWORD,
        campusId,
        partnerCode: `${campusKey}PART${pad(i)}`,
        leads: Array.from({ length: COUNTS[campusKey].partnerLeads }, (_, k) => k)
          .filter((k) => k % COUNTS[campusKey].partnerAccounts === i - 1)
          .map((k) => String(oid(`partner-lead:${campusKey}:${pad(k + 1)}`))),
        commissions: Array.from({ length: COUNTS[campusKey].partnerCommissions }, (_, k) => k)
          .filter((k) => k % COUNTS[campusKey].partnerAccounts === i - 1)
          .map((k) => String(oid(`partner-commission:${campusKey}:${pad(k + 1)}`))),
        endpoint: 'POST /api/partners/auth/login',
      });
    }

    accounts[`campus${campusKey}`] = entries;
  });

  return {
    generatedFor: SEED_NAMESPACE,
    anchorDate: ANCHOR_DATE.toISOString(),
    password: TEST_PASSWORD,
    campuses: Object.fromEntries(
      CAMPUS_KEYS.map((key) => [key, { id: String(ctx.campusIds[key]), slug: `fixture-campus-${key.toLowerCase()}` }])
    ),
    accounts,
  };
};

/**
 * @param {Object} ctx
 * @returns {{ file: string, catalogue: Object }}
 */
const writeAccounts = (ctx) => {
  const catalogue = buildCatalogue(ctx);

  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNTS_FILE, `${JSON.stringify(catalogue, null, 2)}\n`, 'utf8');

  return { file: ACCOUNTS_FILE, catalogue };
};

/**
 * Reads the catalogue back. Consumers (CH-2, CH-4, CH-5) go through this rather
 * than re-deriving logins, so a renamed account breaks in one place.
 *
 * @returns {Object}
 * @throws {Error} When the seed has not run yet.
 */
const readAccounts = () => {
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    throw new Error(`No fixture accounts at ${ACCOUNTS_FILE}. Run \`npm run seed:test\` first.`);
  }

  return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
};

/**
 * Renders the account table shown by `npm run seed:test -- --print`.
 *
 * @param {Object} catalogue
 * @returns {string}
 */
const formatAccounts = (catalogue) => {
  const rows = Object.entries(catalogue.accounts).flatMap(([group, entries]) =>
    entries.map((entry) => [group, entry.role, entry.login, entry.loginField, entry.campusId || '—'])
  );

  const header = ['GROUP', 'ROLE', 'LOGIN', 'FIELD', 'CAMPUS ID'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');

  return [
    line(header),
    widths.map((w) => '─'.repeat(w)).join('  '),
    ...rows.map(line),
    '',
    `Password for every account: ${catalogue.password}`,
    `Anchor date: ${catalogue.anchorDate}`,
  ].join('\n');
};

module.exports = { writeAccounts, readAccounts, formatAccounts, GENERATED_DIR, ACCOUNTS_FILE };
