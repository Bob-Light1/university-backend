'use strict';
/** @file whatsapp.repository.test.js @description Atomic cost boundary and callback query identity. */
jest.mock('../../modules/notification/models/whatsapp-usage.model', () => ({ collection: { indexes: jest.fn() }, updateOne: jest.fn(), findOne: jest.fn() }));
jest.mock('../../modules/notification/models/notification.model', () => ({ updateOne: jest.fn(), findOne: jest.fn() }));
const Usage = require('../../modules/notification/models/whatsapp-usage.model');
const Notification = require('../../modules/notification/models/notification.model');
const repo = require('../../modules/notification/whatsapp.repository');
const notifications = require('../../modules/notification/notification.repository');
beforeEach(() => {
  jest.clearAllMocks(); Usage.collection.indexes.mockResolvedValue([{ unique: true, key: { schoolCampus: 1, month: 1 } }]);
  Usage.updateOne.mockResolvedValue({ modifiedCount: 1 }); Notification.updateOne.mockResolvedValue({ modifiedCount: 1 });
});
test('reservation uses the installed unique key and a conditional atomic increment', async () => {
  expect(await repo.reserve('campus-A', '2026-11', 500)).toBe(true);
  expect(Usage.updateOne).toHaveBeenLastCalledWith({ schoolCampus: 'campus-A', month: '2026-11', used: { $lt: 500 } }, { $inc: { used: 1 } });
  Usage.updateOne.mockResolvedValue({ modifiedCount: 0 }); expect(await repo.reserve('campus-A', '2026-11', 500)).toBe(false);
});
test('missing unique index or zero allowance prevents reservation', async () => {
  expect(await repo.reserve('campus-A', '2026-11', 0)).toBe(false); expect(Usage.updateOne).not.toHaveBeenCalled();
  Usage.collection.indexes.mockResolvedValue([{ key: { schoolCampus: 1, month: 1 } }]);
  await expect(repo.reserve('campus-A', '2026-11', 500)).rejects.toThrow(/installed unique/);
  expect(Usage.updateOne).not.toHaveBeenCalled();
});
test('concurrent first-bucket duplicate retries the guarded update without resetting usage', async () => {
  Usage.updateOne.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 11000 }));
  expect(await repo.reserve('campus-A', '2026-11', 500)).toBe(true);
  expect(Usage.updateOne).toHaveBeenCalledTimes(2);
});
test('callback update binds known submission identity and only advances status rank', async () => {
  const at = new Date();
  await notifications.recordWhatsappStatus({ notificationId: 'n1', messageId: 'wamid.1', phoneNumberId: '123', phone: '+237600000001', status: 'read', rank: 5, at });
  expect(Notification.updateOne).toHaveBeenCalledWith({ _id: 'n1', $or: [{ 'whatsapp.messageId': null }, { 'whatsapp.messageId': 'wamid.1' }], channel: 'whatsapp', to: '+237600000001', 'whatsapp.phoneNumberId': '123', 'whatsapp.submissionStartedAt': { $ne: null }, 'whatsapp.deliveryRank': { $lt: 5 } }, { $set: { 'whatsapp.messageId': 'wamid.1', 'whatsapp.deliveryStatus': 'read', 'whatsapp.deliveryRank': 5, 'whatsapp.statusAt': at, status: 'sent', workerClaimedAt: null } });
});
test('acceptance does not overwrite a racing delivery/read receipt', async () => {
  await notifications.acceptWhatsapp('n1', 'wamid.1');
  expect(Notification.updateOne.mock.calls[0][1].$set['whatsapp.deliveryStatus']).toBeUndefined();
  expect(Notification.updateOne.mock.calls[1][0]).toEqual({ _id: 'n1', 'whatsapp.deliveryRank': { $lt: 1 } });
});

test('a partial unique index does not protect every campus bucket', async () => {
  Usage.collection.indexes.mockResolvedValue([{ unique: true, key: { schoolCampus: 1, month: 1 }, partialFilterExpression: { schoolCampus: 'some-other-campus' } }]);
  await expect(repo.reserve('campus-A', '2026-11', 500)).rejects.toThrow(/installed unique/);
  expect(Usage.updateOne).not.toHaveBeenCalled();
});

test('first submission initializes receipt state for legacy rows without WhatsApp metadata', async () => {
  await notifications.startWhatsappSubmission('legacy', '123', '+237600000001');
  const update = Notification.updateOne.mock.calls[0][1].$set;
  expect(update.to).toBe('+237600000001');
  expect(update['whatsapp.deliveryRank']).toBe(0);
  expect(update['whatsapp.deliveryStatus']).toBe('unknown');
});
