'use strict';
/** @file whatsapp.journey.js @description Real isolated consent, quota races, replay authorization and signed receipt acceptance. */
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto'); const assert = require('node:assert/strict');
if (process.env.NODE_ENV === 'production') throw new Error('WhatsApp journey refuses production');
const previousDirectory = process.cwd();
const runtime = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'erp-whatsapp-'));
process.chdir(runtime);
Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: crypto.randomBytes(48).toString('hex'), REDIS_URL: '', AI_SERVICE_URL: '', DOC_STORAGE_PROVIDER: 'local', UPLOAD_DIR: path.join(runtime, 'uploads') });
for (const key of Object.keys(process.env)) if (/SMTP|WHATSAPP|CLOUDINARY|MAIL_|TWILIO|SENDGRID|RESEND/.test(key)) process.env[key] = '';
const mongoose = require('mongoose'); const request = require('supertest');
const { seed, startEphemeralDatabase } = require('./seed'); const { loadAllModels } = require('./models'); const { readAccounts } = require('./exports');
const C = require('../../shared/constants/whatsapp.constants');
let checks = 0; const check = (label, condition) => { assert.ok(condition, label); checks++; console.log(`  ✓ ${label}`); };
/** Only this process's disposable replica set is created and mutated. Provider fetch is intercepted. */
async function main() {
  const handle = await startEphemeralDatabase(); const oldFetch = global.fetch;
  try {
    mongoose.set('autoIndex', false); mongoose.set('autoCreate', false);
    await mongoose.connect(handle.uri); loadAllModels(); await seed({});
    await require('../../scripts/prepare-auth-sessions').prepareAuthSessions({ apply: true });
    const { prepareWhatsapp } = require('../../scripts/prepare-whatsapp');
    check('preparation is read-only by default', (await prepareWhatsapp()).applied === false);
    await prepareWhatsapp({ apply: true }); await prepareWhatsapp({ apply: true });
    check('index preparation is repeatable', (await prepareWhatsapp()).collections.length === 2);
    const app = require('../../app'); app.set('trust proxy', 'loopback');
    const catalog = readAccounts(); const actors = Object.values(catalog.accounts).flat();
    const a = catalog.campuses.A.id; const b = catalog.campuses.B.id;
    const Notification = mongoose.model('Notification'); const Usage = mongoose.model('WhatsAppUsage'); const Campus = mongoose.model('Campus');
    const tokens = {}; const users = {}; let ip = 1;
    for (const [key, role, campusId] of [['admin', 'ADMIN'], ['student', 'STUDENT', a], ['managerA', 'CAMPUS_MANAGER', a], ['managerB', 'CAMPUS_MANAGER', b], ['partner', 'PARTNER', a]]) {
      const actor = actors.find(row => row.role === role && (!campusId || row.campusId === campusId));
      const response = await request(app).post(actor.endpoint.split(' ')[1]).set('X-Forwarded-For', `192.0.2.${ip++}`).send({ [actor.loginField]: actor.login, password: actor.password });
      assert.equal(response.status, 200); tokens[key] = response.body.data.token; users[key] = actor;
    }
    const authed = (method, route, who = 'student') => request(app)[method](`/api/notifications${route}`).auth(tokens[who], { type: 'bearer' });
    check('consent requires authentication', (await request(app).get('/api/notifications/my/whatsapp-consent')).status === 401);
    check('legacy preferences do not grant consent', !(await authed('get', '/my/whatsapp-consent')).body.data.enabled);
    check('grant refuses stale consent version', (await authed('put', '/my/whatsapp-consent').send({ enabled: true, phone: '+237600000001', version: 'old' })).status === 400);
    check('grant refuses local-only phone', (await authed('put', '/my/whatsapp-consent').send({ enabled: true, phone: '600000001', version: C.CONSENT_VERSION })).status === 400);
    const phone = '+237600000001';
    const grant = async (who = 'student', number = phone) => authed('put', '/my/whatsapp-consent', who).send({ enabled: true, phone: number, version: C.CONSENT_VERSION, userId: users.managerB.id, campusId: b });
    check('grant derives identity despite forged body identifiers', (await grant()).status === 200 && !(await authed('get', '/my/whatsapp-consent', 'managerB')).body.data.enabled);
    check('usage refuses non-management callers', (await authed('get', '/whatsapp-usage')).status === 403);
    check('manager usage ignores forged campus and stays scoped to campus A', (await authed('get', `/whatsapp-usage?campusId=${b}`, 'managerA')).body.data.campusId === a);
    check('global actor must select a campus', (await authed('get', '/whatsapp-usage', 'admin')).status === 400);
    await Campus.updateOne({ _id: a }, { $set: { 'entitlement.plan': 'premium', 'entitlement.modules': [] } });
    require('../../shared/lib/entitlement').cache.clear();
    const service = require('../../modules/notification').service;
    const cfg = require('../../shared/configs/general.config').notification.whatsapp;
    let submits = 0;
    global.fetch = async (url, options) => {
      assert.match(url, /^https:\/\/graph\.facebook\.com\//); submits++;
      const body = JSON.parse(options.body); assert.equal(body.type, 'template'); assert.equal(body.to, phone.slice(1));
      return { ok: true, json: async () => ({ messages: [{ id: `wamid.synthetic.${submits}` }] }) };
    };
    const recipient = { id: users.student.id, model: 'Student', campusId: a, phone, prefs: { whatsapp: false } };
    const notify = (template = 'result.published', extra = {}) => service.notify({ recipient, channels: ['inapp', 'whatsapp'], template, locale: 'fr', data: { amount: 12, currency: 'XAF', dueDate: '01/11/2026', count: 3 }, ...extra });
    let rows = await notify();
    check('unconfigured channel is inert and preserves in-app inbox', rows[0].status === 'sent' && rows[1].status === 'skipped' && submits === 0);
    Object.assign(cfg, { token: 'synthetic', phoneNumberId: '12345', appSecret: 'synthetic-secret', verifyToken: 'synthetic-verify', apiVersion: 'v21.0' });
    rows = await notify();
    check('unapproved template cannot submit or consume quota', rows[1].status === 'skipped' && submits === 0 && await Usage.countDocuments({ schoolCampus: a }) === 0);
    cfg.approvedTemplates = JSON.stringify(Object.keys(C.TEMPLATE_PARAMETERS).reduce((map, key) => ({ ...map, [key]: { fr: { approved: true, name: `erp_${key.replaceAll('.', '_')}`, language: 'fr' } } }), {}));
    rows = await notify(); const first = rows[1]._id;
    check('explicit consent overrides legacy false flag and sends exactly once', rows[1].status === 'sent' && submits === 1);
    check('provider acceptance is distinct from delivery', (await Notification.findById(first).lean()).whatsapp.deliveryStatus === 'accepted');
    const month = new Date().toISOString().slice(0, 7);
    check('reservation is recorded before submission', (await Usage.findOne({ schoolCampus: a, month })).used === 1);
    await authed('put', '/my/whatsapp-consent').send({ enabled: false });
    rows = await notify();
    check('withdrawal stops future sends without stopping in-app', rows[0].status === 'sent' && rows[1].status === 'skipped' && submits === 1);
    check('revocation retains evidence', Boolean((await authed('get', '/my/whatsapp-consent')).body.data.revokedAt));
    await grant();
    const changed = await notify('result.published', { recipient: { ...recipient, phone: '+237600000002' } });
    check('changing recipient number requires new matching consent', changed[1].status === 'skipped' && submits === 1);
    for (const template of Object.keys(C.TEMPLATE_PARAMETERS)) {
      rows = await notify(template); check(`${template} submits its configured approved payload`, rows[1].status === 'sent');
    }
    const managerPhone = '+237600000009'; await grant('managerA', managerPhone);
    const beforeRetry = submits;
    const foreign = await Notification.create({ recipientId: b, recipientModel: 'Campus', schoolCampus: b, channel: 'email', template: 'generic', status: 'skipped', body: 'synthetic' });
    check('manager cannot replay another campus notification', (await authed('post', `/${foreign._id}/retry`, 'managerA')).status === 404);
    check('partner cannot replay management notifications', (await authed('post', `/${foreign._id}/retry`, 'partner')).status === 403);
    check('accepted message is never resubmitted', (await authed('post', `/${first}/retry`, 'managerA')).status === 200 && submits === beforeRetry);
    const signature = (body) => `sha256=${crypto.createHmac('sha256', cfg.appSecret).update(body).digest('hex')}`;
    const callback = (status, options = {}) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: options.sender || '12345' }, statuses: [{ id: 'wamid.synthetic.1', status, timestamp: '1793491200', recipient_id: options.phone || phone.slice(1), biz_opaque_callback_data: String(first) }] } }] }] });
    const post = (body, signed = true) => { const req = request(app).post('/api/notifications/whatsapp/webhook').set('Content-Type', 'application/json'); return (signed ? req.set('x-hub-signature-256', signature(body)) : req).send(body); };
    check('webhook verification refuses absent/wrong token', (await request(app).get('/api/notifications/whatsapp/webhook?hub.mode=subscribe&hub.challenge=123&hub.verify_token=wrong')).status === 403);
    check('webhook verification returns exact challenge', (await request(app).get('/api/notifications/whatsapp/webhook?hub.mode=subscribe&hub.challenge=123&hub.verify_token=synthetic-verify')).text === '123');
    check('unsigned callback is refused', (await post(callback('delivered'), false)).status === 403);
    const raw = callback('delivered');
    check('tampered raw bytes are refused', (await request(app).post('/api/notifications/whatsapp/webhook').set('Content-Type', 'application/json').set('x-hub-signature-256', signature(raw)).send(` ${raw}`)).status === 403);
    check('signed delivered callback is accepted', (await post(raw)).status === 200 && (await Notification.findById(first).lean()).whatsapp.deliveryStatus === 'delivered');
    await post(callback('sent')); await post(raw); await post(callback('failed'));
    check('duplicates/out-of-order/failure do not regress delivery', (await Notification.findById(first).lean()).whatsapp.deliveryStatus === 'delivered');
    await post(callback('read', { sender: '99999' })); await post(callback('read', { phone: '237600000002' }));
    check('wrong sender or recipient cannot update a known message', (await Notification.findById(first).lean()).whatsapp.deliveryStatus === 'delivered');
    await post(callback('read'));
    check('read callback updates provider receipt only', (await Notification.findById(first).lean()).whatsapp.deliveryStatus === 'read' && (await Notification.findById(first).lean()).readAt === null);
    for (const state of ['read_only', 'hidden', 'enabled']) {
      await Campus.updateOne({ _id: a }, { $set: { 'entitlement.modules': [{ key: 'result', state, setBy: 'admin' }] } });
      require('../../shared/lib/entitlement').cache.clear();
      rows = await notify(); check(`originating entitlement ${state} governs emission`, state === 'enabled' ? rows[1].status === 'sent' : rows.length === 0);
    }
    const legacy = await Notification.collection.insertOne({ recipientId: new mongoose.Types.ObjectId(users.student.id), recipientModel: 'Student', schoolCampus: new mongoose.Types.ObjectId(a), channel: 'whatsapp', template: 'result.published', locale: 'fr', data: {}, to: phone.slice(1), status: 'skipped', attempts: 0, maxAttempts: 3 });
    const legacyRetry = await authed('post', `/${legacy.insertedId}/retry`, 'managerA');
    check('legacy skipped row initializes acceptance metadata on its first template submission', legacyRetry.status === 200 && (await Notification.findById(legacy.insertedId).lean()).whatsapp.deliveryStatus === 'accepted');
    const legacyRow = await Notification.findById(legacy.insertedId).lean();
    const legacyCallback = JSON.parse(callback('delivered'));
    Object.assign(legacyCallback.entry[0].changes[0].value.statuses[0], { id: legacyRow.whatsapp.messageId, biz_opaque_callback_data: String(legacy.insertedId) });
    await post(JSON.stringify(legacyCallback));
    check('legacy phone without a plus is normalized for receipt identity matching', (await Notification.findById(legacy.insertedId).lean()).whatsapp.deliveryStatus === 'delivered' && legacyRow.to === phone);
    await Usage.updateOne({ schoolCampus: a, month }, { $set: { used: 4999 } });
    const beforeRace = submits;
    const raced = await Promise.all(Array.from({ length: 12 }, () => notify()));
    check('twelve concurrent sends cannot exceed the final quota slot', raced.filter(row => row[1].status === 'sent').length === 1 && submits === beforeRace + 1 && (await Usage.findOne({ schoolCampus: a, month })).used === 5000);
    check('another campus keeps its independent budget', await Usage.countDocuments({ schoolCampus: b }) === 0);
    const exhausted = (await authed('get', '/whatsapp-usage', 'managerA')).body.data;
    check('usage reports exhausted quota', exhausted.used === 5000 && exhausted.remaining === 0 && exhausted.limit === 5000);
    await Usage.updateOne({ schoolCampus: a, month }, { $set: { used: 10 } });
    const oldDate = new Date('2026-01-01T00:00:00Z');
    await Usage.create({ schoolCampus: a, month: '2026-01', used: 5000 });
    check('prior-month counters do not consume current month allowance', (await service.whatsapp.getUsage(a)).used === 10 && oldDate.getUTCMonth() === 0);
    global.fetch = async () => { submits++; throw new Error('synthetic timeout with private provider payload'); };
    rows = await notify(); const ambiguous = rows[1]._id; const afterFailure = submits;
    check('provider exception is sanitized and retains budget reservation', rows[1].status === 'failed' && (await Notification.findById(ambiguous).lean()).lastError === C.REASONS.FAILED && (await Usage.findOne({ schoolCampus: a, month })).used === 11);
    await service.runRetryJob(); await authed('post', `/${ambiguous}/retry`, 'managerA');
    check('ambiguous submission is never resubmitted by worker or manual retry', submits === afterFailure);
    const index = (await Usage.collection.indexes()).find(row => row.unique);
    await Usage.collection.dropIndex(index.name);
    rows = await notify();
    check('missing installed unique index fails closed before provider call', rows[1].status === 'failed' && submits === afterFailure);
    console.log(`WhatsApp journey: ${checks}/${checks} checks passed`);
  } finally {
    global.fetch = oldFetch;
    await require('../../shared/middleware/rate-limiter').shutdownRateLimiter();
    await mongoose.disconnect(); await handle.stop(); process.chdir(previousDirectory); fs.rmSync(runtime, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
