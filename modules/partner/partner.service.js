'use strict';

/**
 * @file partner.service.js — inter-module API of the partner domain.
 *
 * Single consumer: public-portal (pre-registration, alert opt-in,
 * partner applications, competition winner contacts).
 *
 * All persistence goes through partner.repository (step 0 pre-Postgres):
 * this file only carries business orchestration (first-touch deduplication,
 * IP_BURST detection, review transitions), never direct model access.
 */

const partnerRepo = require('./partner.repository');

// ── Partner ───────────────────────────────────────────────────────────────────

/**
 * ACTIVE partner matching a referral code (case-insensitive).
 * @param {string} code
 * @returns {Promise<{_id, email, schoolCampus, partnerCode}|null>} lean
 */
const findActivePartnerByCode = (code) => partnerRepo.findActivePartnerByCode(code);

// ── Leads ─────────────────────────────────────────────────────────────────────

/**
 * Portal pre-registration: silent deduplication (same email OR phone
 * on the same campus, spec §4.1/§9.2, first-touch attribution preserved),
 * otherwise creation with IP_BURST detection (>5 leads same IP hash in <10 min).
 * Updates the partner's lastActivityAt when an attributed lead is created.
 *
 * @param {Object} p — fields already normalized by the caller
 * @param {ObjectId} p.campusId
 * @param {{_id}|null} p.partner — resolved partner (or null for a direct lead)
 * @param {string|null} p.partnerCode
 * @param {string} p.firstName, p.lastName, p.email
 * @param {string|null} p.phone, p.programInterest, p.city, p.country
 * @param {string} p.source
 * @param {Object|null} p.utmParams
 * @param {string} p.ipAddressHash
 * @param {boolean} p.notifyNextBatch
 * @returns {Promise<{leadId, status: string, created: boolean}>}
 */
const upsertPreRegistrationLead = async ({
  campusId, partner, partnerCode,
  firstName, lastName, email, phone,
  programInterest, city, country,
  source, utmParams, ipAddressHash, notifyNextBatch,
}) => {
  const dupOr = [{ email }];
  if (phone) dupOr.push({ phone });

  const existingLead = await partnerRepo.findActiveLeadByContact({ campusId, dupOr });

  if (existingLead) {
    const set = {};
    if (programInterest) set.programInterest = programInterest;
    if (phone && !existingLead.phone) set.phone = phone;
    if (city)    set.city    = city;
    if (country) set.country = country;

    // First-touch: we never re-attribute a lead already linked to a partner.
    if (partner?._id && !existingLead.partner) {
      set.partner     = partner._id;
      set.partnerCode = partnerCode;
      set.source      = source;
    }
    if (notifyNextBatch) set.notifyNextBatch = true;

    const historyEntry = {
      status:    existingLead.status,
      changedBy: null,
      changedAt: new Date(),
      note:      'Portal re-submission — deduplicated update.',
    };

    await partnerRepo.updateLeadById(existingLead._id, set, historyEntry);
    return { leadId: existingLead._id, status: existingLead.status, created: false };
  }

  const fraudFlags = [];
  const tenMinAgo  = new Date(Date.now() - 10 * 60 * 1000);
  const burstCount = await partnerRepo.countRecentLeadsByIp({ ipAddressHash, since: tenMinAgo });
  if (burstCount >= 5) fraudFlags.push('IP_BURST');

  const lead = await partnerRepo.createLead({
    schoolCampus:    campusId,
    partner:         partner?._id || null,
    partnerCode:     partnerCode || null,
    firstName,
    lastName,
    email,
    phone,
    programInterest: programInterest || null,
    city:            city || null,
    country:         country || null,
    source,
    status:          'new',
    statusHistory:   [{ status: 'new', changedBy: null, changedAt: new Date(), note: 'Portal pre-registration.' }],
    utmParams:       utmParams || null,
    ipAddressHash,
    honeypotTripped: false,
    fraudFlags,
    notifyNextBatch: !!notifyNextBatch,
  });

  if (partner?._id) {
    partnerRepo.touchActivity(partner._id).catch(() => {});
  }

  // Anti-fraud alert to the campus manager (Campus account) on IP burst.
  // In-app + email (the latter inert without SMTP); fire-and-forget, never
  // impacts pre-registration. Contact resolved via the campus facade, chained
  // so as not to block the response to the lead.
  if (fraudFlags.includes('IP_BURST')) {
    require('../campus').service.getCampusNotificationContact(campusId)
      .then((contact) => require('../notification').service.notify({
        recipient: {
          id:     campusId,
          model:  'Campus',
          campusId,
          email:  contact?.email,
          phone:  contact?.manager_phone,
          locale: contact?.defaultLanguage,
        },
        channels: ['inapp', 'email'],
        template: 'fraud.alert',
        data:     { count: burstCount },
      }))
      .catch((err) => console.error('[notify] fraud.alert failed:', err.message));
  }

  return { leadId: lead._id, status: lead.status, created: true };
};

/**
 * Session alert opt-in (spec §4.13): existing lead (by email then
 * phone on the campus) → notifyNextBatch=true; otherwise a minimal lead is created.
 * @param {Object} p — fields already normalized by the caller
 * @param {ObjectId} p.campusId
 * @param {string|null} p.email, p.phone, p.programInterest
 * @param {string} p.ipAddressHash
 * @returns {Promise<{leadId, created: boolean}>}
 */
const registerSessionAlert = async ({ campusId, email, phone, programInterest, ipAddressHash }) => {
  let lead = null;
  if (email) {
    lead = await partnerRepo.findLeadByEmailOnCampus(email, campusId);
  }
  if (!lead && phone) {
    lead = await partnerRepo.findLeadByPhoneOnCampus(phone, campusId);
  }

  if (lead) {
    const set = { notifyNextBatch: true };
    if (programInterest && !lead.programInterest) {
      set.programInterest = programInterest;
    }
    await partnerRepo.updateLeadById(lead._id, set);
    return { leadId: lead._id, created: false };
  }

  const newLead = await partnerRepo.createLead({
    schoolCampus:    campusId,
    firstName:       'Alert',
    lastName:        'Subscriber',
    email:           email || `alert-${Date.now()}@noemail.local`,
    phone,
    programInterest: programInterest || null,
    source:          'direct',
    status:          'new',
    statusHistory:   [{ status: 'new', changedBy: null, changedAt: new Date(), note: 'Session alert opt-in.' }],
    ipAddressHash,
    honeypotTripped: false,
    notifyNextBatch: true,
  });

  return { leadId: newLead._id, created: true };
};

/**
 * Contact details of a lead for notification (competition winners).
 * @param {ObjectId|string} leadId
 * @returns {Promise<{firstName, email, phone}|null>} lean
 */
const getLeadContact = (leadId) => partnerRepo.getLeadContact(leadId);

// ── Applications (partner applications, spec §4.9) ─────────────────────────

/**
 * Public submission of a partner application.
 * @param {Object} data — fields validated/normalized by the caller
 * @returns {Promise<{applicationId}>}
 */
const createApplication = async (data) => {
  const doc = await partnerRepo.createApplication(data);
  return { applicationId: doc._id };
};

/**
 * Paginated list of applications (back-office), honeypot excluded.
 * @param {Object} p
 * @param {Object} p.campusFilter — campus scoping filter (already built)
 * @param {string} [p.status] — 'pending' | 'approved' | 'rejected'
 * @param {number} [p.page=1], [p.limit=20]
 * @returns {Promise<{data: Object[], total: number}>}
 */
const listApplications = async ({ campusFilter = {}, status, page = 1, limit = 20 }) => {
  const filter = { honeypotTripped: false, ...campusFilter };
  if (status) filter.status = status;

  const skip = (Number(page) - 1) * Number(limit);
  return partnerRepo.paginateApplications(filter, { skip, limit: Number(limit) });
};

/**
 * Application by id, within the caller's campus scope.
 * @returns {Promise<Object|null>} lean
 */
const getApplicationById = (id, campusFilter = {}) =>
  partnerRepo.findApplicationScoped(id, campusFilter);

/**
 * Review of an application (approve/reject). Approval does NOT create a
 * Partner — the admin does it manually; we only set status +
 * partnerId reference.
 * @returns {Promise<{result: 'NOT_FOUND'|'CONFLICT'|'OK', application?: Object}>}
 */
const reviewApplication = async ({ id, campusFilter = {}, status, reviewNote, partnerId, reviewerId }) => {
  const doc = await partnerRepo.findApplicationScoped(id, campusFilter);
  if (!doc) return { result: 'NOT_FOUND' };
  if (doc.status !== 'pending') return { result: 'CONFLICT' };

  const set = { status, reviewedBy: reviewerId, reviewedAt: new Date() };
  if (reviewNote) set.reviewNote = reviewNote;
  if (status === 'approved' && partnerId) set.partnerId = partnerId;

  const application = await partnerRepo.updateApplicationScoped(id, campusFilter, set);
  return { result: 'OK', application };
};

/**
 * Deletion of an application within the caller's campus scope.
 * @returns {Promise<boolean>} true if deleted
 */
const deleteApplication = (id, campusFilter = {}) =>
  partnerRepo.deleteApplicationScoped(id, campusFilter);

module.exports = {
  findActivePartnerByCode,
  upsertPreRegistrationLead,
  registerSessionAlert,
  getLeadContact,
  createApplication,
  listApplications,
  getApplicationById,
  reviewApplication,
  deleteApplication,
};
