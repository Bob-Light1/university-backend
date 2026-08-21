'use strict';

/**
 * @file journey.js
 * @description Executable proof of the §13.2 reference journey of
 * `docs/architecture/CAMPUS_ENTITLEMENT_DESIGN.md` — the parts that need a real
 * database and therefore cannot live in the Jest suite, which deliberately
 * opens no MongoDB connection (see `jest.config.js`).
 *
 *   npm run test:journey
 *
 * Same shape as `self-check.js`, and for the same reason: it boots one
 * throwaway replica set, seeds the deterministic fixture, loads the real
 * `app.js` and drives it over HTTP with the fixture's own accounts. Nothing
 * here can reach a real database — `assertTestDatabaseUri` refuses anything but
 * a loopback host named like a test database (§4.4).
 *
 * ── WHAT IT PROVES THAT THE UNIT SUITE CANNOT ───────────────────────────────
 * The unit and integration suites pin the resolver, the guard and the gate in
 * isolation, on mocks. This runs the same rules against REAL DATA, and that is
 * where §4.1.1 and §6.3.3 actually live: whether a module can be hidden depends
 * on what the campus has recorded, so the refusal only appears when a campus
 * genuinely holds rows. Campus A of the fixture holds finance rows — which is
 * why hiding Finance here must be refused, and why the refusal has to name the
 * remedy it expects the operator to take instead.
 *
 * Not part of `npm test`: it needs a mongod binary, which the unit suite
 * deliberately does not.
 */

const mongoose = require('mongoose');
const request = require('supertest');

const { seed, startEphemeralDatabase } = require('./seed');
const { loadAllModels } = require('./models');
const { readAccounts } = require('./exports');

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

/** Trims a response body down to something readable in a failure line. */
const brief = (res) => `${res.status} ${JSON.stringify(res.body).slice(0, 140)}`;

/** The refusal code the gate or the guard put in `errors.code`. */
const codeOf = (res) => res.body?.errors?.code ?? null;

/**
 * @returns {Promise<void>}
 */
const main = async () => {
  console.log('› booting throwaway replica set…');
  const handle = await startEphemeralDatabase();

  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  process.env.MONGODB_URI = handle.uri;
  await mongoose.connect(handle.uri);
  loadAllModels();

  try {
    await seed({});

    // Required AFTER the seed: app.js has no side effect on load, but the
    // accounts export it reads is written by the seed.
    const app = require('../../app');
    const accounts = readAccounts();
    const campusA = accounts.campuses.A.id;
    const password = accounts.password;

    const login = async (path, body) => {
      const res = await request(app).post(path).send(body);
      const token = res.body?.data?.token;
      if (!token) throw new Error(`login ${path} failed: ${brief(res)}`);
      return token;
    };

    const admin = await login('/api/admin/login', { email: 'admin@fixture.test', password });
    const manager = await login('/api/campus/login', { email: 'campus.a@fixture.test', password });

    const entitlementOf = async (token) => {
      const res = await request(app)
        .get('/api/settings/entitlement')
        .set('Authorization', `Bearer ${token}`);
      return res.body?.data ?? {};
    };

    const setOffer = (body) => request(app)
      .patch(`/api/admin/campuses/${campusA}/entitlement`)
      .set('Authorization', `Bearer ${admin}`)
      .send(body);

    const setUsage = (body) => request(app)
      .patch(`/api/campus/${campusA}/entitlement`)
      .set('Authorization', `Bearer ${manager}`)
      .send(body);

    // ── Act 1 — the sale ────────────────────────────────────────────────────
    console.log('\n› act 1 — ADMIN sells the standard tier');
    let res = await setOffer({ plan: 'standard', reason: 'campus opening — GAET upsell to revisit' });
    record('the offer is accepted', res.status < 300, brief(res));
    record('the tier is read back', (await entitlementOf(manager)).plan === 'standard');

    // ── The two guards the manager must not get past ────────────────────────
    console.log('\n› act 1bis — the usage layer cannot widen the offer');
    res = await setUsage({ modules: [{ key: 'gaet', state: 'enabled', reason: 'I want GAET right now' }] });
    record('widening refused with 403', res.status === 403, brief(res));
    record('code is FEATURE_NOT_IN_OFFER', codeOf(res) === 'FEATURE_NOT_IN_OFFER', codeOf(res));

    console.log('\n› act 1ter — the usage layer cannot lock itself out');
    res = await setUsage({ modules: [{ key: 'student', state: 'hidden', reason: 'lock myself out please' }] });
    record('self-lockout refused with 409', res.status === 409, brief(res));
    record('code is FEATURE_CORE', codeOf(res) === 'FEATURE_CORE', codeOf(res));

    // ── Act 5 — the freeze, not the cut ─────────────────────────────────────
    console.log('\n› act 5 — announcements frozen, history kept');
    res = await setUsage({ modules: [{ key: 'announcement', state: 'read_only', reason: 'usage to agree with the office' }] });
    record('the freeze is accepted', res.status < 300, brief(res));

    res = await request(app).get('/api/announcements').set('Authorization', `Bearer ${manager}`);
    record('reads still served — the history stays readable', res.status === 200, brief(res));

    res = await request(app).post('/api/announcements')
      .set('Authorization', `Bearer ${manager}`)
      .send({ title: 'journey', content: 'journey', audience: 'all' });
    record('writes refused with 403', res.status === 403, brief(res));
    record('code is FEATURE_READ_ONLY', codeOf(res) === 'FEATURE_READ_ONLY', codeOf(res));

    // ── Act 2 — the §4.1.1 floor, on real rows ──────────────────────────────
    console.log('\n› act 2 — Finance holds records, so it cannot be hidden');
    res = await setUsage({ modules: [{ key: 'finance', state: 'hidden', reason: 'no formal accounting here' }] });
    record('hiding refused with 409', res.status === 409, brief(res));
    record('code is FEATURE_HAS_RECORDS', codeOf(res) === 'FEATURE_HAS_RECORDS', codeOf(res));
    record('the refusal carries its blocker list',
      Array.isArray(res.body?.errors?.blockers) && res.body.errors.blockers.length > 0,
      JSON.stringify(res.body?.errors?.blockers ?? null).slice(0, 100));
    record('the refusal names its remedy', /read_only/.test(res.body?.message ?? ''), res.body?.message);

    console.log('\n› act 2bis — the remedy the refusal named');
    res = await setUsage({ modules: [{ key: 'finance', state: 'read_only', reason: 'ledger frozen this term' }] });
    record('freezing is accepted where hiding was not', res.status < 300, brief(res));

    res = await request(app).get('/api/finance/expenses').set('Authorization', `Bearer ${manager}`);
    record('the ledger stays readable', res.status === 200, brief(res));

    res = await request(app).post('/api/finance/expenses')
      .set('Authorization', `Bearer ${manager}`)
      .send({ amount: 1000, description: 'journey', expenseCategory: null });
    record('the ledger refuses writes', res.status === 403 && codeOf(res) === 'FEATURE_READ_ONLY', brief(res));

    // ── Act 6 — the upsell ──────────────────────────────────────────────────
    console.log('\n› act 6 — premium opens GAET to the usage layer');
    res = await setOffer({ plan: 'premium', reason: 'campus grew — GAET upsell' });
    record('the upsell is accepted', res.status < 300, brief(res));

    res = await setUsage({ modules: [{ key: 'gaet', state: 'enabled', reason: 'enabling GAET after the upsell' }] });
    record('what was refused in act 1bis now passes', res.status < 300, brief(res));

    // ── Campus isolation ────────────────────────────────────────────────────
    console.log('\n› isolation — the other campus saw none of it');
    const managerB = await login('/api/campus/login', { email: 'campus.b@fixture.test', password });
    record('campus B carries no tier of its own',
      (await entitlementOf(managerB)).plan !== 'premium');

    // ── The estate view ─────────────────────────────────────────────────────
    console.log('\n› the estate view answers');
    res = await request(app).get('/api/admin/entitlement/overview').set('Authorization', `Bearer ${admin}`);
    record('GET /admin/entitlement/overview → 200', res.status === 200, brief(res));
  } finally {
    await mongoose.disconnect();
    await handle.stop();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.error(`\n✗ ${failed.length} check(s) failed:`);
    failed.forEach((r) => console.error(`   - ${r.label}${r.detail ? ` — ${r.detail}` : ''}`));
    process.exitCode = 1;
  } else {
    console.log('✓ the §13.2 journey holds end to end.');
  }
};

if (require.main === module) {
  main().catch((err) => {
    console.error('journey failed:', err);
    process.exitCode = 1;
  });
}

module.exports = { main };
