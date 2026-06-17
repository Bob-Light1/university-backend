'use strict';

/**
 * @file partner.service.js — API inter-modules du domaine partner.
 *
 * Consommateur unique : public-portal (pré-inscription, opt-in alerte,
 * candidatures partenaire, contacts gagnants de compétition).
 *
 * Toute la persistance passe par partner.repository (étape 0 pré-Postgres) :
 * ce fichier ne porte que l'orchestration métier (déduplication first-touch,
 * détection IP_BURST, transitions de revue), jamais d'accès model direct.
 */

const partnerRepo = require('./partner.repository');

// ── Partner ───────────────────────────────────────────────────────────────────

/**
 * Partenaire ACTIF correspondant à un code de parrainage (insensible à la casse).
 * @param {string} code
 * @returns {Promise<{_id, email, schoolCampus, partnerCode}|null>} lean
 */
const findActivePartnerByCode = (code) => partnerRepo.findActivePartnerByCode(code);

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

  const existingLead = await partnerRepo.findActiveLeadByContact({ campusId, dupOr });

  if (existingLead) {
    const set = {};
    if (programInterest) set.programInterest = programInterest;
    if (phone && !existingLead.phone) set.phone = phone;
    if (city)    set.city    = city;
    if (country) set.country = country;

    // First-touch : on ne réattribue jamais un lead déjà rattaché à un partenaire.
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

  // Alerte anti-fraude au gestionnaire du campus (compte Campus) si rafale d'IP.
  // In-app uniquement (inbox du campus) ; fire-and-forget, n'impacte jamais la
  // pré-inscription du lead. Le compte Campus porte email/manager_phone : un push
  // email pourra s'ajouter plus tard via lookup du contact campus.
  if (fraudFlags.includes('IP_BURST')) {
    require('../notification').service.notify({
      recipient: { id: campusId, model: 'Campus', campusId },
      channels: ['inapp'],
      template: 'fraud.alert',
      data:     { count: burstCount },
    }).catch((err) => console.error('[notify] fraud.alert failed:', err.message));
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
 * Coordonnées d'un lead pour notification (gagnants de compétition).
 * @param {ObjectId|string} leadId
 * @returns {Promise<{firstName, email, phone}|null>} lean
 */
const getLeadContact = (leadId) => partnerRepo.getLeadContact(leadId);

// ── Applications (candidatures partenaire, spec §4.9) ─────────────────────────

/**
 * Dépôt public d'une candidature partenaire.
 * @param {Object} data — champs validés/normalisés par l'appelant
 * @returns {Promise<{applicationId}>}
 */
const createApplication = async (data) => {
  const doc = await partnerRepo.createApplication(data);
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
  return partnerRepo.paginateApplications(filter, { skip, limit: Number(limit) });
};

/**
 * Candidature par id, dans le périmètre campus de l'appelant.
 * @returns {Promise<Object|null>} lean
 */
const getApplicationById = (id, campusFilter = {}) =>
  partnerRepo.findApplicationScoped(id, campusFilter);

/**
 * Revue d'une candidature (approve/reject). L'approbation ne crée PAS de
 * Partner — l'admin le fait manuellement ; on ne fait que poser status +
 * référence partnerId.
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
 * Suppression d'une candidature dans le périmètre campus de l'appelant.
 * @returns {Promise<boolean>} true si supprimée
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
