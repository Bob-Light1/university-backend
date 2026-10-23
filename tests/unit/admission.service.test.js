'use strict';

/** @file admission.service.test.js @description Admission authority and stale/terminal preconditions before any creation. */
jest.mock('../../modules/partner/admission.repository');
jest.mock('../../modules/notification', () => ({ service: { notify: jest.fn().mockResolvedValue([]) } }));
const mongoose = require('mongoose');
const repo = require('../../modules/partner/admission.repository');
const service = require('../../modules/partner/admission.service');
const { ADMISSION_ERRORS: E, LEAD_STATUS: S } = require('../../shared/constants/admission.constants');
const tx = jest.spyOn(mongoose.connection, 'transaction').mockImplementation((work) => work({ synthetic: true }));
const input = { id: 'lead-a', campusFilter: { schoolCampus: 'campus-a' }, actor: { id: 'actor-a', role: 'CAMPUS_MANAGER' }, revision: 2 };
beforeEach(() => {
  jest.clearAllMocks();
  repo.findLead.mockResolvedValue({ _id: 'lead-a', schoolCampus: 'campus-a', status: S.SUBMITTED, dossier: { revision: 2 } });
});
afterAll(() => tx.mockRestore());

test.each(['CAMPUS_MANAGER', 'PARTNER', 'STUDENT', 'TEACHER', 'PARENT', 'MENTOR', 'STAFF'])('%s cannot pronounce admission', async (role) => {
  await expect(service.transition({ ...input, actor: { id: 'actor-a', role }, status: S.ADMITTED })).rejects.toMatchObject({ code: E.FORBIDDEN, statusCode: 403 });
  expect(repo.mutateLead).not.toHaveBeenCalled();
});

test('a candidate capability cannot choose enrollment even with an injected management role', async () => {
  await expect(service.transition({ ...input, actor: { id: 'candidate', role: 'ADMIN' }, candidate: true, status: S.ENROLLED })).rejects.toMatchObject({ code: E.FORBIDDEN });
});

test('stale revisions refuse decisions before a mutation or side effect', async () => {
  await expect(service.transition({ ...input, actor: { id: 'admin', role: 'ADMIN' }, status: S.ADMITTED, revision: 1 })).rejects.toMatchObject({ code: E.CONFLICT });
  expect(repo.mutateLead).not.toHaveBeenCalled();
});

test('legacy enrollments require explicit reconciliation', async () => {
  repo.findLead.mockResolvedValue({ _id: input.id, status: S.ENROLLED, student: null });
  await expect(service.transition({ ...input, status: S.ENROLLED })).rejects.toMatchObject({ code: E.HISTORICAL });
});

test.each(['ADMIN', 'DIRECTOR'])('%s can admit the exact submitted revision', async (role) => {
  repo.mutateLead.mockResolvedValue({ _id: input.id, status: S.ADMITTED });
  const result = await service.transition({ ...input, actor: { id: 'decision-maker', role }, status: S.ADMITTED });
  expect(result.lead.status).toBe(S.ADMITTED);
  expect(repo.mutateLead).toHaveBeenCalled();
});
