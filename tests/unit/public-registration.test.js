'use strict';

/**
 * @file public-registration.test.js
 * @description Pre-registration antifraud at its owning backend boundary.
 * Synthetic requests only; no database, queue, notification or provider access.
 */

jest.mock('../../modules/partner', () => ({ service: { findActivePartnerByCode: jest.fn() } }));
jest.mock('../../modules/public-portal/public-portal.queue', () => ({ enqueueIngestion: jest.fn() }));
jest.mock('../../modules/public-portal/portal-campus', () => ({ resolvePortalCampus: jest.fn() }));
jest.mock('../../modules/partner/partner.repository', () => ({
  findActiveLeadByContact: jest.fn(), updateLeadById: jest.fn(),
  countRecentLeadsByIp: jest.fn(), createLead: jest.fn(), touchActivity: jest.fn(),
}));
jest.mock('../../modules/campus', () => ({ service: { getCampusNotificationContact: jest.fn(async () => ({})) } }));
jest.mock('../../modules/notification', () => ({ service: { notify: jest.fn(async () => undefined) } }));

const partner = require('../../modules/partner').service;
const { enqueueIngestion } = require('../../modules/public-portal/public-portal.queue');
const { resolvePortalCampus } = require('../../modules/public-portal/portal-campus');
const { publicPreRegister } = require('../../modules/public-portal/controllers/public/public.register.controller');
const repo = require('../../modules/partner/partner.repository');
const { upsertPreRegistrationLead } = require('../../modules/partner/partner.service');
const { notify } = require('../../modules/notification').service;

const CAMPUS = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const payload = { firstName: ' Test ', lastName: ' Applicant ', email: ' APPLICANT@EXAMPLE.TEST ',
  campusSlug: ' Test-Campus ', phone: '+12025550123', source: 'direct', honeypot: '' };
const nextErrors = [];

/** Await the real asyncHandler through its response/next boundary. */
const invoke = (body) => new Promise((resolve, reject) => {
  const res = { status: jest.fn(function (status) { this.statusCode = status; return this; }),
    json: jest.fn(function (data) { resolve({ status: this.statusCode, body: data }); return this; }) };
  publicPreRegister({ body, ipHash: 'synthetic-ip-hash' }, res, error => {
    nextErrors.push(error);
    reject(error);
  });
});

beforeEach(() => {
  jest.resetAllMocks();
  nextErrors.length = 0;
  resolvePortalCampus.mockResolvedValue({ _id: CAMPUS });
  enqueueIngestion.mockResolvedValue(undefined);
  repo.findActiveLeadByContact.mockResolvedValue(null);
  repo.countRecentLeadsByIp.mockResolvedValue(0);
  repo.createLead.mockImplementation(async data => ({ _id: 'synthetic-lead', ...data }));
  repo.touchActivity.mockResolvedValue(undefined);
  require('../../modules/campus').service.getCampusNotificationContact.mockResolvedValue({});
  notify.mockResolvedValue(undefined);
});

describe('public pre-registration controller', () => {
  test('silently discards a honeypot before resolving or writing anything', async () => {
    expect(await invoke({ honeypot: 'bot' })).toEqual({ status: 200, body: { success: true, message: 'Pre-registration received.' } });
    expect(resolvePortalCampus).not.toHaveBeenCalled();
    expect(partner.findActivePartnerByCode).not.toHaveBeenCalled();
    expect(enqueueIngestion).not.toHaveBeenCalled();
  });
  test.each(['email', 'phone'])('rejects partner self-referral by %s', async (field) => {
    partner.findActivePartnerByCode.mockResolvedValue({ _id: 'partner', schoolCampus: CAMPUS,
      partnerCode: 'TESTREF', email: field === 'email' ? 'applicant@example.test' : 'other@example.test',
      phone: field === 'phone' ? '+1 (202) 555-0123' : '+12025550999' });
    const res = await invoke({ ...payload, partnerCode: 'TESTREF' });
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(enqueueIngestion).not.toHaveBeenCalled();
  });
  test('rejects an inactive referral without using a submitted campus', async () => {
    partner.findActivePartnerByCode.mockResolvedValue(null);
    expect((await invoke({ ...payload, partnerCode: 'UNKNOWN' })).status).toBe(404);
    expect(resolvePortalCampus).not.toHaveBeenCalled();
    expect(enqueueIngestion).not.toHaveBeenCalled();
  });
  test('uses the referral campus and preserves normalized attribution in the ingestion job', async () => {
    partner.findActivePartnerByCode.mockResolvedValue({ _id: 'partner', schoolCampus: CAMPUS,
      partnerCode: 'TESTREF', email: 'partner@example.test' });
    const res = await invoke({ ...payload, partnerCode: 'testref', source: 'qr_code', utmParams: { utm_source: 'test' } });
    expect(res.status).toBe(202);
    expect(resolvePortalCampus).toHaveBeenCalledWith(expect.anything(), { id: CAMPUS, write: true });
    expect(enqueueIngestion).toHaveBeenCalledWith({ type: 'pre-register', payload: expect.objectContaining({
      campusId: CAMPUS, partnerId: 'partner', partnerCode: 'TESTREF', firstName: 'Test',
      lastName: 'Applicant', email: 'applicant@example.test', source: 'qr_code',
      ipAddressHash: 'synthetic-ip-hash', utmParams: { utm_source: 'test' },
    }) });
    expect(res.body).not.toHaveProperty('data');
  });
  test('resolves a direct campus as a write and acknowledges only after ingestion', async () => {
    let release;
    enqueueIngestion.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    let responded = false;
    const pending = invoke(payload).then(result => { responded = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    expect(responded).toBe(false);
    expect(resolvePortalCampus).toHaveBeenCalledWith(expect.anything(), { slug: 'test-campus', write: true });
    expect(enqueueIngestion).toHaveBeenCalledWith({ type: 'pre-register', payload: expect.objectContaining({
      campusId: CAMPUS, partnerId: null, partnerCode: null, source: 'direct',
    }) });
    release();
    expect((await pending).status).toBe(202);
  });
  test('stops ingestion when campus access is refused', async () => {
    resolvePortalCampus.mockImplementation(async res => {
      res.status(404).json({ success: false, message: 'Campus not found' });
      return null;
    });
    expect((await invoke(payload)).status).toBe(404);
    // The campus helper can answer before its caller resumes. Drain that
    // continuation so a write after refusal cannot escape this assertion.
    await new Promise(resolve => setImmediate(resolve));
    expect(enqueueIngestion).not.toHaveBeenCalled();
    expect(nextErrors).toEqual([]);
  });
  test('propagates ingestion failure instead of acknowledging a lost lead', async () => {
    enqueueIngestion.mockRejectedValue(new Error('Synthetic queue failure'));
    await expect(invoke(payload)).rejects.toThrow('Synthetic queue failure');
  });
});

describe('partner pre-registration service antifraud', () => {
  const data = { campusId: CAMPUS, partner: { _id: 'new-partner' }, partnerCode: 'TESTREF',
    firstName: 'Test', lastName: 'Applicant', email: 'applicant@example.test', phone: '+12025550123',
    source: 'qr_code', ipAddressHash: 'synthetic-ip-hash', programInterest: 'Program', notifyNextBatch: true };

  test('deduplicates within campus and preserves existing first-touch attribution', async () => {
    repo.findActiveLeadByContact.mockResolvedValue({ _id: 'existing', status: 'contacted', partner: 'first-partner', phone: 'existing-phone' });
    expect(await upsertPreRegistrationLead(data)).toEqual({ leadId: 'existing', status: 'contacted', created: false });
    expect(repo.findActiveLeadByContact).toHaveBeenCalledWith({ campusId: CAMPUS,
      dupOr: [{ email: data.email }, { phone: data.phone }] });
    const patch = repo.updateLeadById.mock.calls[0][1];
    expect(patch).toEqual({ programInterest: 'Program', notifyNextBatch: true });
    expect(repo.createLead).not.toHaveBeenCalled();
    expect(repo.countRecentLeadsByIp).not.toHaveBeenCalled();
  });
  test('attributes an existing direct lead once without making a second lead', async () => {
    repo.findActiveLeadByContact.mockResolvedValue({ _id: 'existing', status: 'new', partner: null });
    await upsertPreRegistrationLead(data);
    expect(repo.updateLeadById.mock.calls[0][1]).toMatchObject({ partner: 'new-partner', partnerCode: 'TESTREF', source: 'qr_code', phone: data.phone });
    expect(repo.createLead).not.toHaveBeenCalled();
  });
  test.each([4, 5])('flags the IP burst boundary at %i prior leads in ten minutes', async (count) => {
    const now = new Date('2026-10-16T10:00:00Z');
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime());
    try {
      repo.countRecentLeadsByIp.mockResolvedValue(count);
      const result = await upsertPreRegistrationLead(data);
      expect(repo.countRecentLeadsByIp).toHaveBeenCalledWith({ ipAddressHash: data.ipAddressHash,
        since: new Date(now.getTime() - 600000) });
      expect(repo.createLead).toHaveBeenCalledWith(expect.objectContaining({ schoolCampus: CAMPUS,
        partner: 'new-partner', ipAddressHash: data.ipAddressHash, fraudFlags: count >= 5 ? ['IP_BURST'] : [] }));
      expect(result).toMatchObject({ leadId: 'synthetic-lead', created: true });
      await new Promise(resolve => setImmediate(resolve));
      expect(notify).toHaveBeenCalledTimes(count >= 5 ? 1 : 0);
    } finally { jest.restoreAllMocks(); }
  });
});
