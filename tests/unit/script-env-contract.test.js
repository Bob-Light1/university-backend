'use strict';

/**
 * @file script-env-contract.test.js
 * @description Regression tests for the migration scripts' database connection contract.
 *
 * `server.js` declares `MONGODB_URI` as a required environment variable, and every module,
 * worker and seed in the repository reads that name. One script —
 * `scripts/migrate-anticheat-legacy-flags.js`, the residual operational step left by
 * REMEDIATION_PLAN.md §7.3 — read `MONGO_URI` instead. The name is a near-miss, so the
 * failure is silent in the worst way: the script exits 1 with "MONGO_URI is not set"
 * against a perfectly configured `.env`, and the message points the operator at the
 * environment rather than at the script. It could never have run, on any host, and the
 * plan recorded it as blocked on network access.
 *
 * These are source scans rather than behavioural assertions, deliberately: a migration
 * script is run by hand, once, against production data. It has no test surface of its own,
 * and the defect class here is a typo in a name that only resolves at runtime — exactly
 * what a scan catches and a unit test of the script's logic would not.
 */

const fs   = require('fs');
const path = require('path');

const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'scripts');

/** The single name the application declares — `server.js` is the source of truth. */
const CANONICAL = 'MONGODB_URI';

/** Reads every `.js` file under scripts/ as `[name, source]` pairs. */
const readScripts = () => fs.readdirSync(SCRIPTS_DIR)
  .filter((file) => file.endsWith('.js'))
  .map((file) => [file, fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf8')]);

const SCRIPTS = readScripts();

describe('scripts/ — database connection environment contract', () => {
  test('the canonical name is the one server.js requires', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
    expect(server).toContain(`'${CANONICAL}'`);
  });

  test('the scan actually has files to scan', () => {
    // Guards against a green run caused by an empty or moved directory.
    expect(SCRIPTS.length).toBeGreaterThan(5);
  });

  test.each(SCRIPTS.map(([name]) => name))(
    '%s does not read the near-miss name MONGO_URI',
    (name) => {
      const [, source] = SCRIPTS.find(([file]) => file === name);
      // \b before MONGO stops this matching MONGODB_URI itself.
      expect(source).not.toMatch(/\bMONGO_URI\b/);
    },
  );

  test('every script that connects to Mongo does so through MONGODB_URI', () => {
    const connecting = SCRIPTS.filter(([, source]) => source.includes('mongoose.connect'));

    expect(connecting.length).toBeGreaterThan(5);

    const offenders = connecting
      .filter(([, source]) => !source.includes(`process.env.${CANONICAL}`))
      .map(([name]) => name);

    expect(offenders).toEqual([]);
  });

  test('a script that guards on a missing URI names the variable it actually reads', () => {
    // The failure mode this pins: a guard printing one name while the connect call reads
    // another sends the operator to fix an environment that was already correct.
    const mismatched = SCRIPTS
      .filter(([, source]) => source.includes('mongoose.connect'))
      .filter(([, source]) => {
        const guarded = /is not set/.test(source);
        return guarded && !new RegExp(`${CANONICAL}[^\\n]*is not set|is not set[^\\n]*${CANONICAL}`).test(source)
          && !source.split('\n').some((line) => /is not set/.test(line) && line.includes(CANONICAL));
      })
      .map(([name]) => name);

    expect(mismatched).toEqual([]);
  });
});

describe('the anti-cheat legacy-flag migration is runnable', () => {
  const source = fs.readFileSync(
    path.join(SCRIPTS_DIR, 'migrate-anticheat-legacy-flags.js'),
    'utf8',
  );

  test('it guards on, and connects with, MONGODB_URI', () => {
    expect(source).toContain(`process.env.${CANONICAL}`);
    expect(source).not.toMatch(/\bMONGO_URI\b/);
  });

  test('it is still dry-run by default — REMEDIATION_PLAN.md §7.3', () => {
    // The fix above makes the script reach the database for the first time. That must not
    // also make it write on a bare invocation.
    expect(source).toMatch(/const APPLY\s*=\s*args\.includes\('--apply'\)/);
    expect(source).toMatch(/if \(!APPLY\) continue;/);
  });

  test('--purge is never the default', () => {
    expect(source).toMatch(/const PURGE\s*=\s*args\.includes\('--purge'\)/);
  });
});
