'use strict';
/** @file whatsapp.test.js @description Template transport, explicit consent, tier limits and callback authentication regressions. */
const crypto = require('node:crypto');
jest.mock('../../modules/notification/whatsapp.repository', () => ({ reserve: jest.fn(), usage: jest.fn() }));
jest.mock('../../modules/notification/notification.repository', () => ({ recordWhatsappStatus: jest.fn() }));
jest.mock('../../modules/settings/settings.repository', () => ({ findByUserId: jest.fn(), upsertWithSet: jest.fn() }));
jest.mock('../../modules/campus', () => ({ service: { getCampusEntitlement: jest.fn() } }));
jest.mock('../../modules/settings', () => ({ service: { whatsappConsent: require('../../modules/settings/whatsapp-consent.service') } }));
const service = require('../../modules/notification/whatsapp.service');
const templates = require('../../modules/notification/whatsapp.templates');
const channel = require('../../modules/notification/channels/whatsapp.channel');
const config = require('../../shared/configs/general.config').notification.whatsapp;
const settings = require('../../modules/settings').service.whatsappConsent;
const prefs = require('../../modules/settings/settings.repository');
const usage = require('../../modules/notification/whatsapp.repository');
const repo = require('../../modules/notification/notification.repository');
const campus = require('../../modules/campus').service;
const C = require('../../shared/constants/whatsapp.constants');
const { WHATSAPP_MONTHLY_LIMITS } = require('../../shared/constants/features.constants');
const id = '000000000000000000000001'; const campusId = '000000000000000000000002';
const doc = { _id: id, recipientId: id, recipientModel: 'Student', schoolCampus: campusId, channel: 'whatsapp', to: '+237600000001', template: 'result.published', locale: 'fr', data: {} };
const consent = { enabled: true, phone: doc.to, version: C.CONSENT_VERSION, grantedAt: new Date(), revokedAt: null };
const oldFetch = global.fetch;
beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(config, { token: 'synthetic-token', phoneNumberId: '12345', apiVersion: 'v21.0', appSecret: 'synthetic-secret', verifyToken: 'synthetic-verify', timeoutMs: 1000,
    approvedTemplates: JSON.stringify({ 'result.published': { fr: { approved: true, name: 'erp_result_published', language: 'fr' } } }) });
  prefs.findByUserId.mockResolvedValue({ userModel: 'Student', campusId, whatsappConsent: consent });
  usage.reserve.mockResolvedValue(true); usage.usage.mockResolvedValue({ used: 4 });
  campus.getCampusEntitlement.mockResolvedValue({ entitlement: { plan: 'free' } });
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: 'wamid.synthetic' }] }) });
});
afterAll(() => { global.fetch = oldFetch; });

test('explicit consent is bound to authenticated identity, model, campus, phone and version', async () => {
  expect(await service.prepare(doc)).toHaveProperty('template.name', 'erp_result_published');
  expect(usage.reserve).toHaveBeenCalledWith(campusId, expect.stringMatching(/^\d{4}-\d{2}$/), 500);
  for (const patch of [{ enabled: false }, { phone: '+237600000002' }, { version: 'old' }, { revokedAt: new Date() }, { grantedAt: null }]) {
    prefs.findByUserId.mockResolvedValue({ userModel: 'Student', campusId, whatsappConsent: { ...consent, ...patch } });
    expect(await service.prepare(doc)).toEqual({ reason: C.REASONS.CONSENT });
  }
  for (const patch of [{ userModel: 'Parent' }, { campusId: '000000000000000000000003' }, { whatsappConsent: null }]) {
    prefs.findByUserId.mockResolvedValue({ userModel: 'Student', campusId, whatsappConsent: consent, ...patch });
    expect(await service.prepare(doc)).toEqual({ reason: C.REASONS.CONSENT });
  }
});
test('legacy true flags and missing preferences never imply WhatsApp consent', async () => {
  prefs.findByUserId.mockResolvedValue({ userModel: 'Student', campusId, notificationPrefs: { whatsapp: true } });
  expect(await service.prepare(doc)).toEqual({ reason: C.REASONS.CONSENT });
  expect(usage.reserve).not.toHaveBeenCalled();
});
test('self-service grant requires an explicit international number and current version; withdrawal retains evidence', async () => {
  const user = { id, role: 'STUDENT', campusId };
  expect(settings.identity({ id, role: 'DIRECTOR' })).toEqual({ userId: id, userModel: 'Director', campusId: null });
  for (const input of [{ enabled: 'true' }, { enabled: true, phone: '600000001' }, { enabled: true, phone: doc.to, version: 'old' }]) {
    await expect(settings.update(user, input)).rejects.toHaveProperty('statusCode', 400);
  }
  await settings.update(user, { enabled: true, phone: doc.to, version: C.CONSENT_VERSION, campusId: 'untrusted' });
  expect(prefs.upsertWithSet).toHaveBeenCalledWith(id, expect.objectContaining({ userModel: 'Student', campusId, whatsappConsent: expect.objectContaining({ enabled: true, grantedAt: expect.any(Date) }) }), { userId: id });
  const revoked = await settings.update(user, { enabled: false });
  expect(revoked).toMatchObject({ enabled: false, phone: doc.to, revokedAt: expect.any(Date) });
});
test('submission fence, missing campus and exhausted quota prevent a request', async () => {
  expect(await service.prepare({ ...doc, schoolCampus: null })).toEqual({ reason: C.REASONS.CAMPUS });
  expect(await service.prepare({ ...doc, whatsapp: { submissionStartedAt: new Date() } })).toEqual({ reason: C.REASONS.UNKNOWN });
  usage.reserve.mockResolvedValue(false);
  expect(await service.prepare(doc)).toEqual({ reason: C.REASONS.QUOTA });
});
test.each([['free', 500], ['standard', 2000], ['premium', 5000], ['custom', 0], [null, 0], ['unknown', 0]])('tier %s has allowance %s', async (plan, limit) => {
  campus.getCampusEntitlement.mockResolvedValue({ entitlement: { plan } });
  expect(await service.getUsage(campusId)).toMatchObject({ plan, limit, used: 4, remaining: Math.max(0, limit - 4) });
});
test('missing campus and unavailable dependencies fail closed', async () => {
  campus.getCampusEntitlement.mockResolvedValue(null);
  expect(await service.getUsage(campusId)).toHaveProperty('limit', 0);
  prefs.findByUserId.mockRejectedValue(new Error('unavailable'));
  await expect(service.prepare(doc)).rejects.toThrow('unavailable');
  expect(usage.reserve).not.toHaveBeenCalled();
});
test('only the exact approved locale/name pair can send, with no free-text fallback', () => {
  expect(templates.resolve('generic', 'fr', { body: 'text' })).toBeNull();
  expect(templates.resolve(doc.template, 'en')).toBeNull();
  expect(templates.resolve(doc.template, 'fr-CA')).toBeNull();
  for (const value of ['bad json', '{}', JSON.stringify({ [doc.template]: { fr: { approved: false, name: 'erp_result_published', language: 'fr' } } })]) {
    config.approvedTemplates = value;
    expect(templates.resolve(doc.template, 'fr')).toBeNull();
  }
});
test('submission catalogue covers seven templates and ten locales with exact positional parameters', () => {
  const catalog = templates.submissionCatalog();
  expect(catalog).toHaveLength(70);
  for (const entry of catalog) {
    expect(entry.body).toBeTruthy();
    expect(entry.body).not.toMatch(/(?<!\{)\{[a-zA-Z]/);
    expect(entry.parameters).toEqual(C.TEMPLATE_PARAMETERS[entry.key]);
  }
  expect(Object.values(WHATSAPP_MONTHLY_LIMITS)).toEqual([500, 2000, 5000]);
});
test('transport sends approved templates with bounded timeout and opaque correlation', async () => {
  const template = templates.resolve(doc.template, doc.locale);
  expect(await channel.send({ to: doc.to, template, notificationId: id })).toEqual({ messageId: 'wamid.synthetic', phoneNumberId: '12345' });
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toBe('https://graph.facebook.com/v21.0/12345/messages');
  expect(options.signal).toBeInstanceOf(AbortSignal);
  expect(JSON.parse(options.body)).toEqual({ messaging_product: 'whatsapp', to: '237600000001', type: 'template', template, biz_opaque_callback_data: id });
});
test('transport errors never expose provider body, token or private contacts', async () => {
  global.fetch.mockResolvedValue({ ok: false, status: 403, text: () => 'private provider detail' });
  await expect(channel.send({ to: doc.to, template: {}, notificationId: id })).rejects.toThrow('HTTP 403');
  config.token = '';
  expect(channel.isConfigured()).toBe(false);
  await expect(channel.send({ to: doc.to, template: {} })).rejects.toThrow(/not configured/);
});
test('HMAC authenticates exact raw bytes and rejects missing/malformed/changed signatures', () => {
  const raw = Buffer.from('{ "object": "whatsapp_business_account" }');
  const signature = `sha256=${crypto.createHmac('sha256', config.appSecret).update(raw).digest('hex')}`;
  expect(service.validSignature(raw, signature)).toBe(true);
  for (const [body, sig] of [[Buffer.from(raw.toString().replace(' ', '')), signature], [raw, 'sha256=bad'], [raw, null], [undefined, signature]]) expect(service.validSignature(body, sig)).toBe(false);
  config.appSecret = ''; expect(service.validSignature(raw, signature)).toBe(false);
});
test('callbacks ignore other accounts, invalid identities, unknown states and invalid timestamps', async () => {
  const status = { id: 'wamid.synthetic', status: 'delivered', timestamp: '1793491200', recipient_id: '237600000001', biz_opaque_callback_data: id };
  const payload = (s = status, phone = '12345') => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: phone }, statuses: [s] } }] }] });
  await service.receive(payload());
  expect(repo.recordWhatsappStatus).toHaveBeenCalledWith({ notificationId: id, messageId: status.id, phoneNumberId: '12345', phone: doc.to, status: 'delivered', rank: 4, at: expect.any(Date) });
  jest.clearAllMocks();
  await service.receive(payload(status, 'other'));
  for (const patch of [{ status: 'unknown' }, { timestamp: 'invalid' }, { recipient_id: '' }, { biz_opaque_callback_data: 'forged' }]) await service.receive(payload({ ...status, ...patch }));
  expect(repo.recordWhatsappStatus).not.toHaveBeenCalled();
});
