'use strict';

/** @file announcement-audit.journey.js @description Real HTTP ownership/entitlement, rollback, retries and expiry audit proof on an owned database. */
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
if (process.env.NODE_ENV === 'production') throw new Error('Announcement audit journey refuses production');
const previousDirectory = process.cwd();
const runtime = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'erp-announcement-audit-'));
process.chdir(runtime);
Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: crypto.randomBytes(48).toString('hex'), REDIS_URL: '', AI_SERVICE_URL: '', DOC_STORAGE_PROVIDER: 'local', UPLOAD_DIR: path.join(runtime, 'uploads') });
for (const key of Object.keys(process.env)) if (/SMTP|WHATSAPP|CLOUDINARY|MAIL_|TWILIO|SENDGRID|RESEND/.test(key)) process.env[key] = '';
const mongoose = require('mongoose'); const request = require('supertest');
const { seed, startEphemeralDatabase } = require('./seed');
const { assertTestDatabaseUri } = require('./seed.config');
const { oid } = require('./ids'); const { readAccounts } = require('./exports');
const { prepareAuditJournal } = require('../../scripts/prepare-audit-journal');
const { prepareAuthSessions } = require('../../scripts/prepare-auth-sessions');
const { STATUS, OPERATION, SWEEP_PAGE_SIZE } = require('../../modules/announcement/announcement.constants');
const { constants: { ACTOR, MODE } } = require('../../modules/audit');
const { FEATURE_STATES, FEATURE_ERROR_CODES } = require('../../shared/constants/features.constants');
const { softDeletePatch } = require('../../shared/utils/soft-delete');
const mutations = require('../../modules/announcement').service;
const Announcement = require('../../modules/announcement/models/announcement.model');
const AuditEvent = require('../../modules/audit/models/audit-event.model');
let passed = 0;
/** Record only assertion labels, never accounts, tokens or fixture data. */
function record(label) { passed += 1; console.log(`PASS ${label}`); }

/** All data belongs to the guarded ephemeral replica set created by this process. */
async function main() {
  const handle = await startEphemeralDatabase();
  try {
    assertTestDatabaseUri(handle.uri);
    await mongoose.connect(handle.uri, { autoIndex: false, autoCreate: false });
    await seed({}); await prepareAuthSessions({ apply: true }); await prepareAuditJournal({ apply: true });
    const app = require('../../app'); app.set('trust proxy', 'loopback');
    const catalog = readAccounts(); const accounts = Object.values(catalog.accounts).flat();
    const campusA = catalog.campuses.A.id; const campusB = catalog.campuses.B.id;
    const tokens = {}; const users = {}; let ip = 1;
    for (const [key, role, campus] of [['admin', 'ADMIN'], ['managerA', 'CAMPUS_MANAGER', campusA], ['managerB', 'CAMPUS_MANAGER', campusB], ['student', 'STUDENT', campusA]]) {
      const actor = accounts.find(row => row.role === role && (!campus || row.campusId === campus));
      const response = await request(app).post(actor.endpoint.split(' ')[1]).set('X-Forwarded-For', `192.0.2.${ip++}`).send({ [actor.loginField]: actor.login, password: actor.password });
      assert.equal(response.status, 200); tokens[key] = response.body.data.token;
      users[key] = { id: actor.id, role: actor.role, campusId: actor.campusId };
    }
    const Campus = mongoose.model('Campus');
    for (const campus of [campusA, campusB]) await Campus.updateOne({ _id: campus }, { $set: { 'entitlement.plan': 'premium', 'entitlement.modules': [] } });
    require('../../shared/lib/entitlement').cache.clear();
    const http = (method, suffix, who = 'managerA') => request(app)[method](`/api/announcements${suffix}`).auth(tokens[who], { type: 'bearer' });
    const events = id => AuditEvent.find({ entityType: 'Announcement', entityId: id }).sort({ createdAt: 1, _id: 1 }).lean();
    const load = id => Announcement.findById(id).lean();
    const fixedDate = new Date('2026-01-01T09:00:00Z');
    /** Explicit synthetic records augment the journey without changing baseline fixture volumes. */
    const create = (key, fields = {}) => Announcement.create({ _id: oid(`announcement-audit:${key}`), schoolCampus: campusA, title: 'Synthetic private title', content: 'Synthetic private content', createdAt: fixedDate, updatedAt: fixedDate, ...fields });

    const created = await http('post', '').send({ title: 'Created draft', content: 'Synthetic body', campusId: campusB, status: STATUS.PUBLISHED, auditEligible: true, publishedAt: fixedDate });
    assert.equal(created.status, 201); const id = created.body.data._id;
    assert.equal(created.body.data.schoolCampus, campusA); assert.equal((await load(id)).status, STATUS.DRAFT); assert.equal((await load(id)).auditEligible, false);
    record('HTTP creation derives campus and ignores forged publication/eligibility');
    assert.equal((await http('put', `/${id}`).send({ title: 'Draft edit' })).status, 200);
    assert.equal((await events(id)).length, 0); record('draft edit produces no post-publication event');
    assert.equal((await http('patch', `/${id}/publish`).send({})).status, 200);
    assert.equal((await load(id)).auditEligible, true); assert.equal((await events(id)).length, 0);
    record('first publication atomically establishes sticky eligibility without event');
    const published = await load(id);
    assert.equal((await http('put', `/${id}`).send({ title: 'Refused' })).status, 400);
    assert.deepEqual(await load(id), published); assert.equal((await events(id)).length, 0);
    record('published edit refusal leaves source and journal unchanged');
    for (const who of ['managerB', 'student']) {
      assert.equal((await http('patch', `/${id}/pin`, who).send({})).status, who === 'student' ? 403 : 404);
      assert.deepEqual(await load(id), published);
    }
    record('cross-campus and unauthorized-role mutations fail without changing state');
    assert.equal((await request(app).patch(`/api/announcements/${id}/pin`).send({})).status, 401);
    record('unauthenticated mutation is refused');
    assert.equal((await http('patch', `/${id}/pin`).send({})).status, 200);
    let rows = await events(id); assert.equal(rows.length, 1);
    assert.equal(String(rows[0].schoolCampus), campusA); assert.equal(String(rows[0].actor.id), users.managerA.id);
    assert.equal(rows[0].actor.kind, ACTOR.USER); assert.equal(rows[0].source.operation, OPERATION.PIN);
    assert.deepEqual(rows[0].changes.map(change => [change.field, change.before, change.after]), [['pinned', false, true]]);
    record('pin event retains actual old/new values, authenticated actor and source campus');
    await http('patch', `/${id}/archive`).send({});
    assert.equal((await load(id)).status, STATUS.ARCHIVED); assert.equal((await events(id)).length, 2);
    record('archiving eligible content records the lifecycle change');
    const edited = await http('put', `/${id}`).send({ title: 'Private replacement', content: 'Private replacement body', targetRoles: ['STUDENT'], auditEligible: false, publishedAt: null, schoolCampus: campusB });
    assert.equal(edited.status, 200); rows = await events(id); const edit = rows[2];
    assert.deepEqual(edit.changes.filter(change => ['title', 'content'].includes(change.field)), [{ field: 'title', mode: MODE.REDACTED }, { field: 'content', mode: MODE.REDACTED }]);
    assert.equal(JSON.stringify(edit).includes('Private replacement'), false);
    assert.equal((await load(id)).auditEligible, true); assert.equal(String((await load(id)).schoolCampus), campusA); assert.ok((await load(id)).publishedAt);
    record('archived edits remain eligible, redact content and reject forged internal fields');
    await http('put', `/${id}`).send({ title: '  Private replacement  ', targetRoles: ['STUDENT'] });
    assert.equal((await events(id)).length, 3); record('normalized no-op produces no event');
    await http('patch', `/${id}/publish`).send({}); assert.equal((await events(id)).length, 4);
    record('republication of the same entity is audited');
    const adminResult = await http('patch', `/${id}/pin`, 'admin').send({});
    assert.equal(adminResult.status, 200); rows = await events(id);
    assert.equal(String(rows[4].schoolCampus), campusA); assert.equal(rows[4].actor.role, 'ADMIN');
    record('global actor event uses the source campus rather than selected/requested scope');

    const beforeFailure = await load(id); const countBeforeFailure = (await events(id)).length;
    const originalInsert = AuditEvent.collection.insertOne;
    AuditEvent.collection.insertOne = async () => { throw new Error('Synthetic journal insert failure'); };
    try { await assert.rejects(mutations.togglePin(id, users.managerA, {}), /Synthetic journal insert failure/); }
    finally { AuditEvent.collection.insertOne = originalInsert; }
    assert.deepEqual(await load(id), beforeFailure); assert.equal((await events(id)).length, countBeforeFailure);
    record('real journal insertion failure rolls back the announcement write');

    const retryDoc = await create('retry', { status: STATUS.PUBLISHED });
    const attempted = []; let attempts = 0;
    AuditEvent.collection.insertOne = async function (data, options) {
      attempted.push({ mutationId: data.mutationId, operationId: data.operationId });
      const inserted = await originalInsert.call(this, data, options);
      if (++attempts === 1) {
        const error = new mongoose.mongo.MongoServerError({ message: 'Synthetic automatic retry' }); error.addErrorLabel('TransientTransactionError'); throw error;
      }
      return inserted;
    };
    try { await mutations.togglePin(retryDoc.id, users.managerA, {}); }
    finally { AuditEvent.collection.insertOne = originalInsert; }
    assert.equal(attempts, 2); assert.deepEqual(attempted[0], attempted[1]); assert.equal((await events(retryDoc._id)).length, 1);
    assert.equal((await load(retryDoc._id)).pinned, true); record('automatic driver retry commits once with stable event identity and re-read state');

    const race = await create('race', { status: STATUS.PUBLISHED });
    await Promise.all([mutations.togglePin(race.id, users.managerA, {}), mutations.togglePin(race.id, users.managerA, {})]);
    assert.equal((await load(race.id)).pinned, false); assert.equal((await events(race._id)).length, 2);
    record('concurrent pin toggles re-read state instead of losing a toggle');

    for (const state of [FEATURE_STATES.READ_ONLY, FEATURE_STATES.HIDDEN, FEATURE_STATES.ENABLED]) {
      await Campus.updateOne({ _id: campusA }, { $set: { 'entitlement.modules': [{ key: 'announcement', state, setBy: 'admin' }] } });
      require('../../shared/lib/entitlement').cache.clear();
      const response = await http('patch', `/${id}/pin`).send({});
      assert.equal(response.status, state === FEATURE_STATES.ENABLED ? 200 : 403);
      if (state !== FEATURE_STATES.ENABLED) assert.equal(response.body.errors.code, state === FEATURE_STATES.READ_ONLY ? FEATURE_ERROR_CODES.FEATURE_READ_ONLY : FEATURE_ERROR_CODES.FEATURE_DISABLED);
      record(`originating announcement entitlement ${state} governs HTTP writes`);
    }
    const beforeRead = await AuditEvent.countDocuments({});
    assert.equal((await http('patch', `/${id}/read`, 'student').send({})).status, 200);
    assert.equal(await AuditEvent.countDocuments({}), beforeRead); record('read receipt stays outside the mutation journal');
    const deletion = await http('delete', `/${id}`); assert.equal(deletion.status, 200);
    const deleted = await load(id); assert.ok(deleted.deletedAt); assert.equal(deleted.status, STATUS.PUBLISHED);
    assert.equal((await events(id)).at(-1).changes[0].field, Object.keys(softDeletePatch(Announcement))[0]);
    record('soft deletion preserves workflow state and records the derived deletion marker');

    // Isolate the sweep from baseline expired announcements without deleting any data.
    const cutoff = new Date('2000-01-02T00:00:00Z'); const due = new Date('2000-01-01T00:00:00Z');
    const expired = await create('expired', { status: STATUS.PUBLISHED, expiresAt: due, pinned: true, pinnedUntil: due });
    const draft = await create('draft', { pinned: true, pinnedUntil: due });
    const hiddenDeleted = await create('deleted', { status: STATUS.PUBLISHED, expiresAt: due, ...softDeletePatch(Announcement, { at: due }) });
    assert.equal(await mutations.archiveExpired(cutoff), 1);
    assert.equal((await events(expired._id))[0].actor.kind, ACTOR.SYSTEM); assert.equal((await load(hiddenDeleted._id)).status, STATUS.PUBLISHED);
    record('expiry commits per eligible live row with a named system actor');
    assert.equal(await mutations.unpinExpired(cutoff), 2); assert.equal((await events(expired._id)).length, 2); assert.equal((await events(draft._id)).length, 0);
    record('automatic unpin covers formerly published rows while excluding draft-only history');
    assert.equal(await mutations.archiveExpired(cutoff), 0); assert.equal(await mutations.unpinExpired(cutoff), 0);
    record('repeated sweeps are idempotent');
    await Announcement.insertMany(Array.from({ length: SWEEP_PAGE_SIZE + 1 }, (_, index) => ({ _id: oid(`announcement-audit:page:${index}`), schoolCampus: campusA, title: 'Paged synthetic title', content: 'Synthetic body', status: STATUS.PUBLISHED, expiresAt: due })));
    assert.equal(await mutations.archiveExpired(cutoff), SWEEP_PAGE_SIZE + 1);
    assert.equal(await AuditEvent.countDocuments({ 'source.operation': OPERATION.EXPIRE }), SWEEP_PAGE_SIZE + 2);
    record('expiry drains beyond one bounded page and journals every committed row');
    const failedSweep = await create('failed-sweep', { status: STATUS.PUBLISHED, expiresAt: due });
    const failedBefore = await load(failedSweep._id);
    AuditEvent.collection.insertOne = async () => { throw new Error('Synthetic sweep failure'); };
    try { await assert.rejects(mutations.archiveExpired(cutoff), error => error.committedCount === 0); }
    finally { AuditEvent.collection.insertOne = originalInsert; }
    assert.deepEqual(await load(failedSweep._id), failedBefore); assert.equal((await events(failedSweep._id)).length, 0);
    record('expiry audit failure leaves the affected row unchanged for the next run');
    console.log(`Announcement audit journey: ${passed}/${passed} checks passed`);
  } finally {
    await require('../../shared/middleware/rate-limiter').shutdownRateLimiter();
    await mongoose.disconnect(); await handle.stop(); process.chdir(previousDirectory); fs.rmSync(runtime, { recursive: true, force: true });
  }
}
main().catch(error => { console.error('Announcement audit journey failed:', error.message); process.exitCode = 1; });
