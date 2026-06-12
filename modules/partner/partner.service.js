'use strict';

/**
 * @file partner.service.js — API inter-modules du domaine partner.
 *
 * Consommateur unique : public-portal (pré-inscription, opt-in alerte,
 * candidatures partenaire, contacts gagnants de compétition).
 */

const Partner            = require('./models/partner.model');
const PartnerLead        = require('./models/partner.lead.model');
const PartnerApplication = require('./models/partner.application.model');

// ── Partner ───────────────────────────────────────────────────────────────────

/**
 * Partenaire ACTIF correspondant à un code de parrainage (insensible à la casse).
 * @param {string} code
 * @returns {Promise<{_id, email, schoolCampus, partnerCode}|null>} lean
 */
const findActivePartnerByCode = (code) =>
  Partner.findOne({
    partnerCode: String(code).toUpperCase().trim(),
    status:      'active',
  }).select('_id email schoolCampus partnerCode').lean();

// ── Leads ─────────────────────────────────────────────────────────────────────

/**
 * Pré-inscription portail : déduplication silencieuse (même email OU téléphone
 * sur le même campus, spec §4.1/§9.2, attribution first-touch conservée),
 * sinon création avec détection IP_BURST (>5 leads même IP hash en <10 min).
 * Met à jour lastActivityAt du partenaire à la création d'un lead attribué.
 *
 * @param {Object} p — champs déjà normalisés par l'appelant
 * @param {ObjectId} p.campusId
 * @param {{_id}|null} p.partner — partenaire résolu (ou null pour un lead direct)
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

  const existingLead = await PartnerLead.findOne({
    schoolCampus:    campusId,
    honeypotTripped: false,
    $or:             dupOr,
  });

  if (existingLead) {
    if (programInterest) existingLead.programInterest = programInterest;
    if (phone && !existingLead.phone) existingLead.phone = phone;
    if (city)    existingLead.city    = city;
    if (country) existingLead.country = country;

    // First-touch : on ne réattribue jamais un lead déjà rattaché à un partenaire.
    if (partner?._id && !existingLead.partner) {
      existingLead.partner     = partner._id;
      existingLead.partnerCode = partnerCode;
      existingLead.source      = source;
    }
    if (notifyNextBatch) existingLead.notifyNextBatch = true;

    existingLead.statusHistory.push({
      status:    existingLead.status,
      changedBy: null,
      changedAt: new Date(),
      note:      'Portal re-submission — deduplicated update.',
    });

    await existingLead.save();
    return { leadId: existingLead._id, status: existingLead.status, created: false };
  }

  const fraudFlags = [];
  const tenMinAgo  = new Date(Date.now() - 10 * 60 * 1000);
  const burstCount = await PartnerLead.countDocuments({
    ipAddressHash,
    createdAt:       { $gte: tenMinAgo },
    honeypotTripped: false,
  });
  if (burstCount >= 5) fraudFlags.push('IP_BURST');

  const lead = new PartnerLead({
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

  await lead.save();

  if (partner?._id) {
    Partner.findByIdAndUpdate(partner._id, { lastActivityAt: new Date() }).exec().catch(() => {});
  }

  return { leadId: lead._id, status: lead.status, created: true };
};

/**
 * Opt-in alerte de session (spec §4.13) : lead existant (par email puis
 * téléphone sur le campus) → notifyNextBatch=true ; sinon lead minimal créé.
 * @param {Object} p — champs déjà normalisés par l'appelant
 * @param {ObjectId} p.campusId
 * @param {string|null} p.email, p.phone, p.programInterest
 * @param {string} p.ipAddressHash
 * @returns {Promise<{leadId, created: boolean}>}
 */
const registerSessionAlert = async ({ campusId, email, phone, programInterest, ipAddressHash }) => {
  let lead = null;
  if (email) {
    lead = await PartnerLead.findOne({ email, schoolCampus: campusId });
  }
  if (!lead && phone) {
    lead = await PartnerLead.findOne({ phone, schoolCampus: campusId });
  }

  if (lead) {
    lead.notifyNextBatch = true;
    if (programInterest && !lead.programInterest) {
      lead.programInterest = programInterest;
    }
    await lead.save();
    return { leadId: lead._id, created: false };
  }

  const newLead = new PartnerLead({
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

  await newLead.save();
  return { leadId: newLead._id, created: true };
};

/**
 * Coordonnées d'un lead pour notification (gagnants de compétition).
 * @param {ObjectId|string} leadId
 * @returns {Promise<{firstName, email, phone}|null>} lean
 */
const getLeadContact = (leadId) =>
  PartnerLead.findById(leadId).select('firstName email phone').lean();

// ── Applications (candidatures partenaire, spec §4.9) ─────────────────────────

/**
 * Dépôt public d'une candidature partenaire.
 * @param {Object} data — champs validés/normalisés par l'appelant
 * @returns {Promise<{applicationId}>}
 */
const createApplication = async (data) => {
  const doc = await PartnerApplication.create(data);
  return { applicationId: doc._id };
};

/**
 * Liste paginée des candidatures (back-office), honeypot exclu.
 * @param {Object} p
 * @param {Object} p.campusFilter — filtre de scoping campus (déjà construit)
 * @param {string} [p.status] — 'pending' | 'approved' | 'rejected'
 * @param {number} [p.page=1], [p.limit=20]
 * @returns {Promise<{data: Object[], total: number}>}
 */
const listApplications = async ({ campusFilter = {}, status, page = 1, limit = 20 }) => {
  const filter = { honeypotTripped: false, ...campusFilter };
  if (status) filter.status = status;

  const skip = (Number(page) - 1) * Number(limit);
  const [data, total] = await Promise.all([
    PartnerApplication.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean(),
    PartnerApplication.countDocuments(filter),
  ]);
  return { data, total };
};

/**
 * Candidature par id, dans le périmètre campus de l'appelant.
 * @returns {Promise<Object|null>} lean
 */
const getApplicationById = (id, campusFilter = {}) =>
  PartnerApplication.findOne({ _id: id, ...campusFilter }).lean();

/**
 * Revue d'une candidature (approve/reject). L'approbation ne crée PAS de
 * Partner — l'admin le fait manuellement ; on ne fait que poser status +
 * référence partnerId.
 * @returns {Promise<{result: 'NOT_FOUND'|'CONFLICT'|'OK', application?: Object}>}
 */
const reviewApplication = async ({ id, campusFilter = {}, status, reviewNote, partnerId, reviewerId }) => {
  const doc = await PartnerApplication.findOne({ _id: id, ...campusFilter });
  if (!doc) return { result: 'NOT_FOUND' };
  if (doc.status !== 'pending') return { result: 'CONFLICT' };

  doc.status     = status;
  doc.reviewedBy = reviewerId;
  doc.reviewedAt = new Date();
  if (reviewNote) doc.reviewNote = reviewNote;
  if (status === 'approved' && partnerId) doc.partnerId = partnerId;

  await doc.save();
  return { result: 'OK', application: doc };
};

/**
 * Suppression d'une candidature dans le périmètre campus de l'appelant.
 * @returns {Promise<boolean>} true si supprimée
 */
const deleteApplication = async (id, campusFilter = {}) => {
  const doc = await PartnerApplication.findOneAndDelete({ _id: id, ...campusFilter });
  return doc != null;
};

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
