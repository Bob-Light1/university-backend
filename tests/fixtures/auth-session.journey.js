'use strict';
/** @file auth-session.journey.js
 * @description Real HTTP/session/lockout regressions on an owned disposable replica set.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
if (process.env.NODE_ENV === 'production') throw new Error('Authentication journey refuses production mode.');
const originalDirectory = process.cwd();
const runtime = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'erp-auth-'));
process.chdir(runtime);
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = require('node:crypto').randomBytes(48).toString('hex');
process.env.AI_SERVICE_URL = ''; process.env.AI_SERVICE_SECRET = ''; process.env.REDIS_URL = '';
for (const key of Object.keys(process.env)) {
  if (/SMTP|CLOUDINARY|MAIL_|SENDGRID|TWILIO|WHATSAPP|RESEND|AT_API_KEY|AT_USERNAME/.test(key)) process.env[key] = '';
}
const mongoose = require('mongoose');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { seed, startEphemeralDatabase } = require('./seed');
const { readAccounts } = require('./exports');
const { loadAllModels } = require('./models');
const C = require('../../modules/account/session.constants');
let checks = 0;
const check = (label, condition) => { assert.ok(condition, label); checks++; console.log(`  ✓ ${label}`); };

/** Exercise actual endpoints and MongoDB atomic updates without a live database URI. */
async function main() {
  const handle = await startEphemeralDatabase();
  try {
    mongoose.set('autoIndex', false); mongoose.set('autoCreate', false);
    await mongoose.connect(handle.uri);
    loadAllModels();
    await seed({});
    // Sessions are created by login, not frozen business seed rows.
    const { prepareAuthSessions } = require('../../scripts/prepare-auth-sessions');
    await prepareAuthSessions({ apply: true });
    await prepareAuthSessions({ apply: true });
    const lockIndexes = await mongoose.model('LoginState').collection.indexes();
    check('expand-only preparation is repeatable and enforces one lock per account',
      lockIndexes.some(index => index.unique && index.key.userModel === 1 && index.key.userId === 1));
    const app = require('../../app');
    app.set('trust proxy', 'loopback');
    let source = 1;
    const login = (actor, password = actor.password, field = actor.loginField, value = actor.login) => request(app)
      .post(actor.endpoint.split(' ')[1]).set('X-Forwarded-For', `192.0.2.${source++}`)
      .send({ [field]: value, password });
    const inspect = (token) => request(app).get('/api/account/session').auth(token, { type: 'bearer' });
    const cookie = (response) => response.headers['set-cookie'][0].split(';')[0];
    const refresh = (response) => request(app).post('/api/account/session/refresh')
      .set('Cookie', cookie(response)).set(C.HEADER, C.HEADER_VALUE)
      .send({ sessionId: jwt.decode(response.body.data.token).sid });
    const catalogue = readAccounts();
    const all = Object.values(catalogue.accounts).flat();
    const sessions = [];
    for (const actor of all) {
      const response = await login(actor);
      check(`${actor.role} login and scoped session`, response.status === 200
        && jwt.decode(response.body.data.token).role === actor.role
        && (jwt.decode(response.body.data.token).campusId ?? null) === actor.campusId);
      check(`${actor.role} live access`, (await inspect(response.body.data.token)).status === 200);
      const renewed = await refresh(response);
      check(`${actor.role} rotating refresh`, renewed.status === 200 && cookie(renewed) !== cookie(response));
      sessions.push({ actor, response: renewed });
    }
    const student = sessions.find(({ actor }) => actor.role === 'STUDENT');
    const { REGISTRY } = require('../../shared/lib/hard-delete/hard-delete.registry');
    const actorRelation = REGISTRY.student.relations.find(relation => relation.model === 'AuthSession');
    const owned = await mongoose.model('AuthSession').find(actorRelation.filter(student.actor.id)).lean();
    check('actor session cascade selects only that model/account', owned.length > 0
      && owned.every(session => session.userModel === 'Student' && String(session.userId) === student.actor.id));
    const campusRelation = REGISTRY.campus.relations.find(relation => relation.model === 'AuthSession');
    const scoped = await mongoose.model('AuthSession').find(campusRelation.filter(student.actor.campusId)).lean();
    check('campus session cascade excludes global actors and the other campus', scoped.length > 0
      && scoped.every(session => String(session.schoolCampus) === student.actor.campusId)
      && scoped.length < sessions.length);
    const first = student.response;
    const competing = await Promise.all([refresh(first), refresh(first)]);
    check('concurrent refresh has exactly one winner', competing.filter((r) => r.status === 200).length === 1);
    const winner = competing.find((r) => r.status === 200);
    check('reuse revokes the winning access token too', (await inspect(winner.body.data.token)).status === 401);

    const fresh = await login(student.actor);
    const sid = jwt.decode(fresh.body.data.token).sid;
    const csrf = await request(app).post('/api/account/session/refresh').set('Cookie', cookie(fresh)).send({ sessionId: sid });
    check('cookie alone is not refresh authority', csrf.status === 401);
    const mismatch = await request(app).post('/api/account/session/refresh').set('Cookie', cookie(fresh))
      .set(C.HEADER, C.HEADER_VALUE).send({ sessionId: jwt.decode(sessions[0].response.body.data.token).sid });
    check('refresh never switches identity', mismatch.status === 401);
    check('CSRF/identity refusal does not revoke the legitimate session', (await inspect(fresh.body.data.token)).status === 200);

    const revoked = await request(app).post('/api/account/session/logout').set('Cookie', cookie(fresh))
      .set(C.HEADER, C.HEADER_VALUE).send({ sessionId: sid });
    check('logout revokes access immediately', revoked.status === 200 && (await inspect(fresh.body.data.token)).status === 401);
    check('logout prevents refresh', (await refresh(fresh)).status === 401);
    const deviceA = await login(student.actor); const deviceB = await login(student.actor);
    const allOut = await request(app).post('/api/account/session/logout-all').auth(deviceA.body.data.token, { type: 'bearer' });
    check('logout-all revokes both devices', allOut.status === 200
      && (await inspect(deviceA.body.data.token)).status === 401 && (await refresh(deviceB)).status === 401);
    check('logout-all preserves another account', (await inspect(sessions[0].response.body.data.token)).status === 200);

    const state = mongoose.model('LoginState');
    const studentModel = mongoose.model('Student');
    const stored = await studentModel.findById(student.actor.id).select('+password').lean();
    for (let i = 0; i < C.MAX_FAILURES; i++) {
      const result = await login(student.actor, 'deliberately-wrong', i % 2 ? 'email' : 'username', i % 2 ? stored.email : stored.username);
      check(`failure ${i + 1} across aliases and source IPs`, result.status === 401);
    }
    check('correct password is refused during account lock', (await login(student.actor)).status === 401);
    await state.updateOne({ userId: stored._id, userModel: 'Student' }, { $set: { expiresAt: new Date(0) } });
    check('expired lock resets without waiting for TTL deletion', (await login(student.actor)).status === 200);
    const failures = await Promise.all(Array.from({ length: C.MAX_FAILURES }, (_, i) =>
      login(student.actor, 'concurrent-wrong', i % 2 ? 'email' : 'username', i % 2 ? stored.email : stored.username)));
    check('concurrent failed logins keep the account-wide threshold', failures.every(response => response.status === 401)
      && (await state.findOne({ userId: stored._id, userModel: 'Student' }).lean()).failures === C.MAX_FAILURES);
    check('concurrent threshold refuses the correct password', (await login(student.actor)).status === 401);
    await state.updateOne({ userId: stored._id, userModel: 'Student' }, { $set: { expiresAt: new Date(0) } });


    const changed = await login(student.actor);
    await studentModel.updateOne({ _id: stored._id }, { $set: { password: 'changed-for-session-test' } });
    check('password change invalidates access and refresh', (await inspect(changed.body.data.token)).status === 401
      && (await refresh(changed)).status === 401);
    await studentModel.updateOne({ _id: stored._id }, { $set: { password: stored.password } });
    const archived = await login(student.actor);
    await studentModel.updateOne({ _id: stored._id }, { $set: require('../../shared/utils/soft-delete').softDeletePatch(studentModel) });
    check('archive invalidates access', (await inspect(archived.body.data.token)).status === 401);
    const admin = sessions.find(({ actor }) => actor.role === 'ADMIN').response;
    await mongoose.model('AuthSession').updateOne({ _id: jwt.decode(admin.body.data.token).sid }, { $set: { revokedAt: new Date() } });
    const bootstrap = await request(app).post('/api/admin/create').auth(admin.body.data.token, { type: 'bearer' }).send({});
    check('administrator creation checks revocation too', bootstrap.status === 401);
    console.log(`\n${checks}/${checks} authentication journey checks passed`);
  } finally {
    await mongoose.disconnect(); await handle.stop();
    process.chdir(originalDirectory); fs.rmSync(runtime, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
