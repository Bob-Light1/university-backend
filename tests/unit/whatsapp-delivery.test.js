'use strict';
/** @file whatsapp-delivery.test.js @description Delivery fences and scoped replay regression checks. */
jest.mock('../../modules/notification/notification.repository');
jest.mock('../../modules/notification/channels');
jest.mock('../../modules/notification/whatsapp.service');
jest.mock('../../shared/lib/entitlement', () => ({ jobs: { isEmissionAllowed: jest.fn().mockResolvedValue(true) } }));
const repo = require('../../modules/notification/notification.repository');
const channels = require('../../modules/notification/channels');
const whatsapp = require('../../modules/notification/whatsapp.service');
const service = require('../../modules/notification/notification.service');
const { jobs } = require('../../shared/lib/entitlement');
const { REASONS } = require('../../shared/constants/whatsapp.constants');
const row = { _id: 'notification', channel: 'whatsapp', template: 'result.published', schoolCampus: 'campus-A', recipientId: 'student', recipientModel: 'Student', to: '+237600000001', status: 'sending' };
let send;
beforeEach(() => {
  jest.clearAllMocks(); jobs.isEmissionAllowed.mockResolvedValue(true);
  send = jest.fn().mockResolvedValue({ messageId: 'wamid.synthetic' });
  channels.get.mockReturnValue({ isConfigured: () => true, send });
  whatsapp.prepare.mockResolvedValue({ template: { name: 'erp_result' } });
  repo.startWhatsappSubmission.mockResolvedValue({ modifiedCount: 1 });
  repo.createMany.mockImplementation(async rows => rows.map((data, index) => ({ ...data, _id: `row-${index}` })));
});
test('delivery checks consent/budget before fencing and submitting the approved template', async () => {
  expect(await service.deliver(row)).toBe('sent');
  expect(whatsapp.prepare).toHaveBeenCalledWith(row);
  expect(send).toHaveBeenCalledWith({ to: row.to, template: { name: 'erp_result' }, notificationId: row._id });
  expect(repo.acceptWhatsapp).toHaveBeenCalledWith(row._id, 'wamid.synthetic');
  expect(repo.markSent).not.toHaveBeenCalled();
});
test('failed preflight or losing the atomic fence never submits', async () => {
  whatsapp.prepare.mockResolvedValue({ reason: REASONS.CONSENT });
  expect(await service.deliver(row)).toBe('skipped');
  expect(repo.startWhatsappSubmission).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  whatsapp.prepare.mockResolvedValue({ template: {} }); repo.startWhatsappSubmission.mockResolvedValue({ modifiedCount: 0 });
  expect(await service.deliver(row)).toBe('sending'); expect(send).not.toHaveBeenCalled();
});
test('provider exceptions are sanitized rather than persisted with private payloads', async () => {
  send.mockRejectedValue(new Error('private token and contact'));
  expect(await service.deliver(row)).toBe('failed');
  expect(repo.markFailed).toHaveBeenCalledWith(row._id, REASONS.FAILED);
});
test('originating entitlement is rechecked before preflight and cost reservation', async () => {
  jobs.isEmissionAllowed.mockResolvedValue(false);
  expect(await service.deliver(row)).toBe('skipped');
  expect(whatsapp.prepare).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
});
test('initial WhatsApp delivery atomically claims the persisted row before sending', async () => {
  repo.claimForSend.mockResolvedValue(null);
  const results = await service.notify({ recipient: { id: 'student', model: 'Student' }, channels: ['whatsapp'], template: 'result.published' });
  expect(results[0].status).toBe('sending'); expect(repo.claimForSend).toHaveBeenCalledWith('row-0'); expect(send).not.toHaveBeenCalled();
});
test('manual replay reads and claims with the same authenticated campus filter', async () => {
  const filter = { schoolCampus: 'campus-A' };
  repo.findById.mockResolvedValue({ ...row, status: 'skipped' }); repo.claimForRetry.mockResolvedValue(row);
  await service.retryOne(row._id, filter);
  expect(repo.findById).toHaveBeenCalledWith(row._id, filter);
  expect(repo.claimForRetry).toHaveBeenCalledWith(row._id, filter);
});
test('known or ambiguous provider submission cannot be manually resubmitted', async () => {
  repo.findById.mockResolvedValue({ ...row, status: 'failed', whatsapp: { submissionStartedAt: new Date() } });
  expect(await service.retryOne(row._id, { schoolCampus: 'campus-A' })).toBe('failed');
  expect(repo.claimForRetry).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
});
