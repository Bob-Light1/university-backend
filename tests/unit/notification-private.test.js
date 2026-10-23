'use strict';

/** @file notification-private.test.js @description Real encryption and private-link delivery regressions. */
jest.mock('../../modules/notification/notification.repository');
jest.mock('../../modules/notification/channels');
jest.mock('../../shared/lib/entitlement', () => ({ jobs: { isEmissionAllowed: jest.fn().mockResolvedValue(true) } }));
jest.mock('../../modules/partner', () => ({ service: { admissionAccess: { authenticate: jest.fn().mockResolvedValue({}) } } }));

const repo = require('../../modules/notification/notification.repository');
const channels = require('../../modules/notification/channels');
const service = require('../../modules/notification/notification.service');
const secret = 'https://example.test/activate/synthetic-bearer';
const input = {
  recipient: { id: 'student-a', model: 'Student', email: 'student@fixture.test' },
  template: 'account.activate', channels: ['email'], data: { name: 'Synthetic', link: secret },
};

beforeEach(() => {
  jest.clearAllMocks();
  repo.createMany.mockImplementation(async (rows) => rows.map((row) => ({ _id: 'delivery-a', ...row })));
  channels.get.mockReturnValue({ isConfigured: () => true, send: jest.fn().mockResolvedValue({ ok: true }) });
  require('../../shared/lib/entitlement').jobs.isEmissionAllowed.mockResolvedValue(true);
});

test('persisted snapshots and API results exclude the bearer; delivery receives it', async () => {
  const result = await service.notify(input);
  const [stored] = repo.createMany.mock.calls[0][0];
  expect(JSON.stringify(stored)).not.toContain(secret);
  expect(stored.privatePayload).toEqual(expect.any(String));
  expect(JSON.stringify(result)).not.toContain('privatePayload');
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(channels.get().send.mock.calls[0][0].body).toContain(secret);
});

test('transactional enqueue never sends before commit and survives worker replay', async () => {
  const session = { synthetic: true };
  await service.notify({ ...input, session });
  expect(repo.createMany).toHaveBeenCalledWith(expect.any(Array), { session });
  expect(channels.get).not.toHaveBeenCalled();
  const [stored] = repo.createMany.mock.calls[0][0];
  await service.deliver({ _id: 'delivery-a', ...stored });
  expect(channels.get().send.mock.calls[0][0].body).toContain(secret);
});

test('ciphertext cannot be moved to another recipient and delivery errors redact credentials', async () => {
  await service.notify({ ...input, session: {} });
  const [stored] = repo.createMany.mock.calls[0][0];
  await service.deliver({ _id: 'delivery-a', ...stored, recipientId: 'student-b' });
  expect(channels.get().send).not.toHaveBeenCalled();
  expect(repo.markFailed).toHaveBeenCalledWith('delivery-a', 'Private notification delivery failed');
  channels.get().send.mockRejectedValueOnce(new Error(`SMTP rejected ${secret}`));
  await service.deliver({ _id: 'delivery-a', ...stored });
  expect(repo.markFailed).toHaveBeenLastCalledWith('delivery-a', 'Private notification delivery failed');
});

test('only the recipient inbox reveals private content and removes ciphertext', async () => {
  await service.notify({ ...input, channels: ['inapp'], session: {} });
  const [stored] = repo.createMany.mock.calls[0][0];
  repo.findInbox.mockResolvedValue([{ _id: 'delivery-a', ...stored }]);
  repo.countInbox.mockResolvedValue(1);
  const result = await service.getInbox({ recipientId: 'student-a' });
  expect(result.data[0].body).toContain(secret);
  expect(result.data[0]).not.toHaveProperty('privatePayload');
  expect(repo.findInbox).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 'student-a' }));
});

test('a revoked dossier link is not sent by a delayed delivery worker', async () => {
  await service.notify({ ...input, template: 'admission.access', session: {}, data: { name: 'Synthetic', link: `http://localhost/en/admission#access=${'a'.repeat(64)}` } });
  const [stored] = repo.createMany.mock.calls[0][0];
  require('../../modules/partner').service.admissionAccess.authenticate.mockRejectedValueOnce(Object.assign(new Error('Revoked'), { statusCode: 410 }));
  expect(await service.deliver({ _id: 'delivery-a', ...stored })).toBe('skipped');
  expect(channels.get().send).not.toHaveBeenCalled();
});

test('queued delivery observes a module frozen after enqueue', async () => {
  await service.notify({ ...input, recipient: { ...input.recipient, campusId: 'campus-a' }, template: 'admission.admitted', session: {} });
  const [stored] = repo.createMany.mock.calls[0][0];
  require('../../shared/lib/entitlement').jobs.isEmissionAllowed.mockResolvedValue(false);
  expect(await service.deliver({ _id: 'delivery-a', ...stored })).toBe('skipped');
  expect(channels.get().send).not.toHaveBeenCalled();
});

test('an unreadable private envelope does not make the entire recipient inbox fail', async () => {
  await service.notify({ ...input, channels: ['inapp'], session: {} });
  const [stored] = repo.createMany.mock.calls[0][0];
  repo.findInbox.mockResolvedValue([{ ...stored, privatePayload: 'damaged' }]);
  repo.countInbox.mockResolvedValue(1);
  const result = await service.getInbox({ recipientId: 'student-a' });
  expect(result.data).toHaveLength(1);
  expect(result.data[0].body).not.toContain(secret);
  expect(result.data[0]).not.toHaveProperty('privatePayload');
});

test('encrypted link variables cannot be redirected by changing the stored destination', async () => {
  await service.notify({ ...input, session: {} });
  const [stored] = repo.createMany.mock.calls[0][0];
  expect(await service.deliver({ _id: 'delivery-a', ...stored, to: 'another@fixture.test' })).toBe('failed');
  expect(channels.get().send).not.toHaveBeenCalled();
});
