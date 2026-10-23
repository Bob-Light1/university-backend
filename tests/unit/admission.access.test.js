'use strict';

/** @file admission.access.test.js @description Public recovery enqueues privately without provider timing or destination overrides. */
jest.mock('../../modules/partner/admission.repository');
jest.mock('../../modules/notification', () => ({ service: {
  notify: jest.fn().mockResolvedValue([{ _id: 'mail-a', channel: 'email', status: 'pending' }]),
  retryOne: jest.fn().mockResolvedValue('sent'),
} }));
const mongoose = require('mongoose');
const repo = require('../../modules/partner/admission.repository');
const notification = require('../../modules/notification').service;
const service = require('../../modules/partner/admission.access.service');
const tx = jest.spyOn(mongoose.connection, 'transaction').mockImplementation((work) => work({ synthetic: true }));
afterAll(() => tx.mockRestore());
beforeEach(() => {
  jest.clearAllMocks();
  repo.findLead.mockResolvedValue({ _id: 'lead-a', schoolCampus: 'campus-a', email: 'stored@fixture.test', firstName: 'Synthetic', status: 'new' });
});

test('public recovery never waits on an external provider and uses only the stored address', async () => {
  await service.requestAccess('submitted@fixture.test', 'campus-a');
  expect(notification.notify).toHaveBeenCalledWith(expect.objectContaining({
    recipient: expect.objectContaining({ email: 'stored@fixture.test' }), session: expect.any(Object),
  }));
  expect(notification.retryOne).not.toHaveBeenCalled();
});

test('unknown recovery contacts issue no credential or notification', async () => {
  repo.findLead.mockResolvedValue(null);
  await service.requestAccess('unknown@fixture.test', 'campus-a');
  expect(notification.notify).not.toHaveBeenCalled();
  expect(repo.setCapability).not.toHaveBeenCalled();
});
