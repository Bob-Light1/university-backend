'use strict';

/** @file admission.access.service.js @description Revocable candidate capabilities and durable private-email delivery. */
const crypto = require('crypto');
const repo = require('./admission.repository');
const { transaction, requireLead } = require('./admission.helper');
const { getPortalBase } = require('../../shared/utils/referral');
const { DOSSIER_LIMITS, ADMISSION_ERRORS: E, admissionError } = require('../../shared/constants/admission.constants');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** A valid capability authorizes exactly the stored lead and its campus. */
async function authenticate(token) {
  const lead = typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) ? await repo.findCapability(hash(token)) : null;
  if (!lead) throw admissionError(E.CAPABILITY, 'This dossier link is invalid or expired', 410);
  return lead;
}

/** Attempt committed intents through the existing atomic notification retry claims. */
async function flush(delivery = []) {
  return Promise.all(delivery.map(async (item) => {
    if (item.channel === 'inapp') return item;
    try {
      return { ...item, status: await require('../notification').service.retryOne(item.id) };
    } catch {
      return { ...item, status: 'pending' };
    }
  }));
}

/** Rotate a private link and enqueue its encrypted email in the same transaction. */
async function issueAccess(id, campusFilter = {}, options = {}) {
  const enqueue = async (session) => {
    const lead = await requireLead(id, campusFilter, session);
    if (['rejected', 'abandoned'].includes(lead.status)) throw admissionError(E.CONFLICT, 'The dossier is closed', 409);
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + DOSSIER_LIMITS.capabilityHours * 3600 * 1000);
    await repo.setCapability({ _id: lead._id, schoolCampus: lead.schoolCampus }, {
      dossierAccessHash: hash(token), dossierAccessExpiresAt: expiresAt,
    }, session);
    // Fragments are not sent in HTTP request URLs or Referer headers.
    const link = `${getPortalBase()}/en/admission#access=${token}`;
    const rows = await require('../notification').service.notify({
      recipient: { id: lead._id, model: 'PartnerLead', email: lead.email, campusId: lead.schoolCampus },
      template: 'admission.access', channels: ['email'], locale: lead.preferredLanguage,
      data: { name: lead.firstName, link }, session,
    });
    return rows.map(({ _id, channel, status }) => ({ id: _id, channel, status }));
  };
  const delivery = options.session ? await enqueue(options.session) : await transaction(enqueue);
  return { delivery: options.deliverNow === false || options.session ? delivery : await flush(delivery) };
}

/** Revoke the limited capability; an existing ERP account is unaffected. */
async function revokeAccess(id, campusFilter = {}) {
  await transaction(async (session) => {
    const lead = await requireLead(id, campusFilter, session);
    await repo.setCapability({ _id: lead._id, schoolCampus: lead.schoolCampus }, {
      dossierAccessHash: null, dossierAccessExpiresAt: null,
    }, session);
  });
}

/** Uniform public recovery: destination always comes from the stored record. */
async function requestAccess(email, campusId) {
  const lead = await repo.findLead({ email: String(email).trim().toLowerCase(), schoolCampus: campusId });
  if (lead && !['rejected', 'abandoned'].includes(lead.status)) await issueAccess(lead._id, { schoolCampus: campusId }, { deliverNow: false });
}

module.exports = { authenticate, issueAccess, revokeAccess, requestAccess, flush };
