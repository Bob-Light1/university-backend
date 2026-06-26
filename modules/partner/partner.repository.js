'use strict';

/**
 * @file partner.repository.js — persistence layer of the partner domain.
 *
 * The ONLY file in the module allowed to query the 4 partner models directly
 * (Partner, PartnerLead, PartnerCommission, PartnerApplication), for the 4
 * controllers (auth, crud, commission, lead) AND the inter-module service.
 * Step 0 of the Postgres preparation — see POSTGRES_MIGRATION_ASSESSMENT.md §7.
 *
 * Conventions:
 *  - reads → .lean() (plain objects); views exposed to the front keep
 *    .lean({ virtuals: true }) (fullName) identical to the original handlers.
 *  - partner writes → the Partner model has a pre('save') hook that hashes the
 *    password: CREATION goes through load→save (new Partner + save) to
 *    trigger it; updates of non-sensitive fields go through atomic
 *    findOneAndUpdate (no hook involved); the password is always
 *    hashed manually by the controller then set via setPartnerPassword.
 *  - Lead / Commission / Application have NO pre/post hook (only a
 *    fullName virtual) → atomic mutations; business preconditions (status,
 *    transition, duplicate) stay in the caller via a prior lean read.
 *  - aggregation pipelines live here; the caller provides the $match (already
 *    cast to ObjectId) and the repo owns the $group stages.
 *  - campus scoping ({ schoolCampus } | {}) is built by the caller and
 *    passed as a parameter (campusFilter).
 *
 * NB: the commission config is embedded in the Campus model (another module).
 * The commission controller accesses it via campus.service (lazy require), not
 * via this repository — see campus.repository.getCampusCommissionConfigWithName /
 * setCampusCommissionConfig.
 */

const Partner           = require('./models/partner.model');
const PartnerLead       = require('./models/partner.lead.model');
const PartnerCommission = require('./models/partner.commission.model');
const PartnerApplication = require('./models/partner.application.model');

// "Safe" projection of a partner exposed to the front-end (no secret).
const SAFE = '-password -__v';

const normCode = (code) => String(code).toUpperCase().trim();

// ── PARTNER : public resolution by code ─────────────────────────────────────

/** ACTIVE partner by referral code (cross-module service). */
const findActivePartnerByCode = (code) =>
  Partner.findOne({ partnerCode: normCode(code), status: 'active' })
    .select('_id email phone schoolCampus partnerCode').lean();

/** Campus branding only (public referral landing) — no partner identity (PII). */
const findActivePartnerByCodeForResolve = (code) =>
  Partner.findOne({ partnerCode: normCode(code), status: 'active' })
    .select('partnerCode schoolCampus')
    .populate('schoolCampus', 'campus_name logo primaryColor')
    .lean();

/** Same + commission config (public pre-registration submission). */
const findActivePartnerForPreRegister = (code) =>
  Partner.findOne({ partnerCode: normCode(code), status: 'active' })
    .select('_id email phone schoolCampus partnerCode commissionConfig tier').lean();

/**
 * Atomically records a referral-link hit on an active partner (top-of-funnel
 * scan/click counter). Increments qrScans when scanned (`isQr`), else linkClicks.
 * @param {string} code — partnerCode
 * @param {boolean} isQr — hit carried ?src=qr
 * @returns {Promise<boolean>} true when an active partner matched the code
 */
const incrementReferralHit = async (code, isQr) => {
  const field = isQr ? 'referralStats.qrScans' : 'referralStats.linkClicks';
  const { matchedCount } = await Partner.updateOne(
    { partnerCode: normCode(code), status: 'active' },
    { $inc: { [field]: 1 }, $set: { 'referralStats.lastReferralHitAt': new Date() } },
  );
  return matchedCount > 0;
};

// ── PARTNER : auth ─────────────────────────────────────────────────────────────

/** Lookup by email (uniqueness check on creation). */
const findPartnerByEmail = (email) => Partner.findOne({ email }).lean();

/** Email taken by ANOTHER partner (uniqueness check on update). */
const findPartnerByEmailExcluding = (email, id) =>
  Partner.findOne({ email, _id: { $ne: id } }).lean();

/** Generates a unique partnerCode (model static). */
const generatePartnerCode = (lastName, firstName, country, year) =>
  Partner.generatePartnerCode(lastName, firstName, country, year);

/** Creates a partner — load→save to trigger the pre('save') hash. @returns {Promise<Document>} */
const createPartner = async (data) => {
  const partner = new Partner(data);
  await partner.save();
  return partner;
};

/** Login: document WITH the hash (comparePassword instance method + toObject). */
const findPartnerByEmailWithPassword = (email) =>
  Partner.findOne({ email }).select('+password');

/** Forgot password: lean read WITH the hash (serves as nonce for the token). */
const findPartnerByEmailWithPasswordLean = (email) =>
  Partner.findOne({ email }).select('+password').lean();

/** Reset: document WITH the hash (nonce verification). */
const findPartnerByIdWithPassword = (id) =>
  Partner.findById(id).select('+password');

/** Sets an already-hashed password. */
const setPartnerPassword = (id, hashedPassword) =>
  Partner.findByIdAndUpdate(id, { password: hashedPassword });

/** Login: timestamps lastLoginAt + lastActivityAt (fire-and-forget, .exec()). */
const touchLoginActivity = (id) =>
  Partner.findByIdAndUpdate(id, { lastLoginAt: new Date(), lastActivityAt: new Date() }).exec();

/** Pre-registration: timestamps lastActivityAt (fire-and-forget, .exec()). */
const touchActivity = (id) =>
  Partner.findByIdAndUpdate(id, { lastActivityAt: new Date() }).exec();

// ── PARTNER : profil (self-service PARTNER) ───────────────────────────────────

/** Logged-in partner's profile (campus-scoped). */
const findOwnProfile = (id, campusId) =>
  Partner.findOne({ _id: id, schoolCampus: campusId }).select(SAFE).lean({ virtuals: true });

/** Logged-in partner's profile WITH the hash (password change). */
const findOwnProfileWithPassword = (id, campusId) =>
  Partner.findOne({ _id: id, schoolCampus: campusId }).select('+password');

/** Updates the fields editable by the partner themselves. */
const updateOwnProfile = (id, campusId, updates) =>
  Partner.findOneAndUpdate(
    { _id: id, schoolCampus: campusId },
    { $set: updates },
    { new: true, runValidators: true }
  ).select(SAFE).lean({ virtuals: true });

/** Updates the profile image. */
const updateOwnProfileImage = (id, campusId, profileImage) =>
  Partner.findOneAndUpdate(
    { _id: id, schoolCampus: campusId },
    { $set: { profileImage } },
    { new: true }
  ).select('_id firstName lastName profileImage').lean({ virtuals: true });

// ── PARTNER : CRUD back-office ────────────────────────────────────────────────

/**
 * Paginated list of partners (filter already built by the caller).
 * @returns {Promise<{data, total}>}
 */
const paginatePartners = async (filter, { skip, limit }) => {
  const [data, total] = await Promise.all([
    Partner.find(filter).select(SAFE).sort({ createdAt: -1 }).skip(skip).limit(limit).lean({ virtuals: true }),
    Partner.countDocuments(filter),
  ]);
  return { data, total };
};

/** Campus-scoped partner, safe projection (getPartner). */
const findPartnerByIdScoped = (id, campusFilter) =>
  Partner.findOne({ _id: id, ...campusFilter }).select(SAFE).lean({ virtuals: true });

/** Campus-scoped partner for the kit (no password, virtuals). */
const findPartnerForKit = (id, campusFilter) =>
  Partner.findOne({ _id: id, ...campusFilter }).select('-password').lean({ virtuals: true });

/** Partner identity fields (commissions summary). */
const findPartnerSummaryFields = (id, campusFilter) =>
  Partner.findOne({ _id: id, ...campusFilter }).select('_id firstName lastName partnerCode').lean();

/** A partner's commission/tier config (commission engine). */
const findPartnerForCommission = (partnerId) =>
  Partner.findById(partnerId).select('commissionConfig tier schoolCampus').lean();

/** Updates a scoped partner (manager fields, runValidators). */
const updatePartnerScoped = (id, campusFilter, updates) =>
  Partner.findOneAndUpdate(
    { _id: id, ...campusFilter },
    { $set: updates },
    { new: true, runValidators: true }
  ).select(SAFE).lean({ virtuals: true });

/** Changes the status of a scoped partner. */
const setPartnerStatusScoped = (id, campusFilter, status) =>
  Partner.findOneAndUpdate(
    { _id: id, ...campusFilter },
    { $set: { status } },
    { new: true }
  ).select(SAFE).lean({ virtuals: true });

/** Restores an archived partner (status archived → active). */
const restorePartnerScoped = (id, campusFilter) =>
  Partner.findOneAndUpdate(
    { _id: id, ...campusFilter, status: 'archived' },
    { $set: { status: 'active' } },
    { new: true }
  ).select(SAFE).lean({ virtuals: true });

/** Partner export (filter already built). */
const listPartnersForExport = (filter) =>
  Partner.find(filter)
    .select('firstName lastName email partnerType tier partnerCode status organization createdAt')
    .sort({ createdAt: -1 }).lean();

// ── LEADS ──────────────────────────────────────────────────────────────────────

/** Creates a lead (no hook). @returns {Promise<Document>} */
const createLead = async (data) => {
  const lead = new PartnerLead(data);
  await lead.save();
  return lead;
};

/** Active lead (non honeypot) by email/phone on a campus (deduplication). */
const findActiveLeadByContact = ({ campusId, dupOr }) =>
  PartnerLead.findOne({ schoolCampus: campusId, honeypotTripped: false, $or: dupOr }).lean();

/** Lead by email on a campus (alert opt-in). */
const findLeadByEmailOnCampus = (email, campusId) =>
  PartnerLead.findOne({ email, schoolCampus: campusId }).lean();

/** Lead by phone on a campus (alert opt-in). */
const findLeadByPhoneOnCampus = (phone, campusId) =>
  PartnerLead.findOne({ phone, schoolCampus: campusId }).lean();

/** Counts leads from the same IP hash since `since` (IP_BURST detection). */
const countRecentLeadsByIp = ({ ipAddressHash, since }) =>
  PartnerLead.countDocuments({ ipAddressHash, createdAt: { $gte: since }, honeypotTripped: false });

/**
 * Paginated list of leads (filter already built, partner populated).
 * @returns {Promise<{data, total}>}
 */
const paginateLeads = async (filter, { skip, limit }) => {
  const [data, total] = await Promise.all([
    PartnerLead.find(filter)
      .populate('partner', 'firstName lastName partnerCode')
      .sort({ createdAt: -1 }).skip(skip).limit(limit).lean({ virtuals: true }),
    PartnerLead.countDocuments(filter),
  ]);
  return { data, total };
};

/** Single scoped lead (filter built by the caller, partner populated). */
const findLeadScoped = (filter) =>
  PartnerLead.findOne(filter).populate('partner', 'firstName lastName partnerCode tier').lean({ virtuals: true });

/** Non-honeypot campus-scoped lead, lean read (transition/deletion precondition). */
const findLeadForWrite = (id, campusFilter) =>
  PartnerLead.findOne({ _id: id, honeypotTripped: false, ...campusFilter }).lean();

/** Advances a lead's status + records history (transition validated by the caller). */
const applyLeadStatus = (id, campusFilter, status, historyEntry) =>
  PartnerLead.findOneAndUpdate(
    { _id: id, honeypotTripped: false, ...campusFilter },
    { $set: { status }, $push: { statusHistory: historyEntry } },
    { new: true }
  ).lean({ virtuals: true });

/** Updates fields of a lead, optional history recording (dedup / opt-in). */
const updateLeadById = (id, set, historyEntry = null) => {
  const update = { $set: set };
  if (historyEntry) update.$push = { statusHistory: historyEntry };
  return PartnerLead.findByIdAndUpdate(id, update);
};

/** Marks a lead as abandoned + records history (soft-delete). */
const softAbandonLead = (id, historyEntry) =>
  PartnerLead.findByIdAndUpdate(id, { $set: { status: 'abandoned' }, $push: { statusHistory: historyEntry } });

/** Attaches the generated commission to the lead. */
const setLeadCommission = (leadId, commissionId) =>
  PartnerLead.findByIdAndUpdate(leadId, { commissionId });

/** A lead's contact details for notification (cross-module service). */
const getLeadContact = (leadId) =>
  PartnerLead.findById(leadId).select('firstName email phone').lean();

/** Lead export (filter already built, partner populated). */
const listLeadsForExport = (filter) =>
  PartnerLead.find(filter)
    .populate('partner', 'firstName lastName partnerCode')
    .select('firstName lastName email phone programInterest source status partnerCode createdAt')
    .sort({ createdAt: -1 }).lean();

/** Total/converted aggregate for a partner ($match provided). */
const aggregateLeadConversionStats = (matchFilter) =>
  PartnerLead.aggregate([
    { $match: matchFilter },
    { $group: {
      _id:      null,
      total:    { $sum: 1 },
      enrolled: { $sum: { $cond: [{ $eq: ['$status', 'enrolled'] }, 1, 0] } },
    } },
  ]);

/** Lead counts grouped by pipeline status ($match provided, KPI summary). */
const aggregateLeadStatusStats = (matchFilter) =>
  PartnerLead.aggregate([
    { $match: matchFilter },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

/**
 * Lead totals grouped by attribution source ($match provided): total and
 * enrolled per source (qr_code | referral_link | manual_code | direct). Powers
 * the QR-vs-link conversion KPIs on the partner and manager dashboards.
 */
const aggregateLeadSourceStats = (matchFilter) =>
  PartnerLead.aggregate([
    { $match: matchFilter },
    { $group: {
      _id:      '$source',
      total:    { $sum: 1 },
      enrolled: { $sum: { $cond: [{ $eq: ['$status', 'enrolled'] }, 1, 0] } },
    } },
  ]);

/** Number of leads (non honeypot) per partner, for a list of ids. */
const aggregateLeadCountsByPartner = (ids) =>
  PartnerLead.aggregate([
    { $match: { partner: { $in: ids }, honeypotTripped: false } },
    { $group: { _id: '$partner', count: { $sum: 1 } } },
  ]);

/** Number of converted (enrolled) leads per partner, for a list of ids. */
const aggregateEnrolledCountsByPartner = (ids) =>
  PartnerLead.aggregate([
    { $match: { partner: { $in: ids }, status: 'enrolled', honeypotTripped: false } },
    { $group: { _id: '$partner', count: { $sum: 1 } } },
  ]);

/** Recent leads of a partner (dashboard). */
const listRecentLeadsForPartner = ({ partnerId, campusId, limit }) =>
  PartnerLead.find({ partner: partnerId, schoolCampus: campusId, honeypotTripped: false })
    .select('firstName lastName source status createdAt')
    .sort({ createdAt: -1 }).limit(limit).lean();

/** Lead counts (non honeypot) of a partner. */
const countLeadsForPartner = (partnerId) =>
  PartnerLead.countDocuments({ partner: partnerId, honeypotTripped: false });

/** Converted (enrolled) lead counts of a partner. */
const countEnrolledLeadsForPartner = (partnerId) =>
  PartnerLead.countDocuments({ partner: partnerId, status: 'enrolled' });

// ── COMMISSIONS ──────────────────────────────────────────────────────────────

/** Existing commission for a lead (engine idempotence). */
const findCommissionByLead = (leadId) =>
  PartnerCommission.findOne({ lead: leadId }).lean();

/** Creates a commission (no hook). @returns {Promise<Document>} */
const createCommission = async (data) => {
  const commission = new PartnerCommission(data);
  await commission.save();
  return commission;
};

/**
 * Paginated list of commissions (filter already built, partner + lead populated).
 * @returns {Promise<{data, total}>}
 */
const paginateCommissions = async (filter, { skip, limit }) => {
  const [data, total] = await Promise.all([
    PartnerCommission.find(filter)
      .populate('partner', 'firstName lastName partnerCode')
      .populate('lead',    'firstName lastName email')
      .sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    PartnerCommission.countDocuments(filter),
  ]);
  return { data, total };
};

/** Campus-scoped commission, lean read (transition precondition). */
const findCommissionScoped = (id, campusFilter) =>
  PartnerCommission.findOne({ _id: id, ...campusFilter }).lean();

/** Applies fields to a scoped commission (transition validated by the caller). */
const updateCommissionScoped = (id, campusFilter, set) =>
  PartnerCommission.findOneAndUpdate({ _id: id, ...campusFilter }, { $set: set }, { new: true }).lean();

/** Commission export (filter already built, partner + lead populated). */
const listCommissionsForExport = (filter) =>
  PartnerCommission.find(filter)
    .populate('partner', 'firstName lastName partnerCode')
    .populate('lead',    'firstName lastName email')
    .sort({ createdAt: -1 }).lean();

/** Receipt: PAID commission of the logged-in partner (partner + lead populated). */
const findPaidCommissionReceipt = ({ id, partnerId, campusId }) =>
  PartnerCommission.findOne({ _id: id, partner: partnerId, schoolCampus: campusId, status: 'paid' })
    .populate('partner', 'firstName lastName partnerCode')
    .populate('lead',    'firstName lastName email')
    .lean();

/** Recent commissions of a partner (dashboard). */
const listRecentCommissionsForPartner = ({ partnerId, campusId, limit }) =>
  PartnerCommission.find({ partner: partnerId, schoolCampus: campusId })
    .select('amount currency status paymentChannel createdAt')
    .sort({ createdAt: -1 }).limit(limit).lean();

/** Blocking commissions (pending/validated) of a partner (archival guard). */
const countBlockingCommissions = (partnerId) =>
  PartnerCommission.countDocuments({ partner: partnerId, status: { $in: ['pending', 'validated'] } });

/** Aggregate of commissions grouped by status ($match provided). */
const aggregateCommissionStatusStats = (matchFilter) =>
  PartnerCommission.aggregate([
    { $match: matchFilter },
    { $group: {
      _id:      '$status',
      count:    { $sum: 1 },
      totalAmt: { $sum: '$amount' },
    } },
  ]);

// ── APPLICATIONS (candidatures partenaire) ────────────────────────────────────

/** Creates an application. @returns {Promise<Document>} */
const createApplication = (data) => PartnerApplication.create(data);

/**
 * Liste paginée des candidatures (filtre déjà construit).
 * @returns {Promise<{data, total}>}
 */
const paginateApplications = async (filter, { skip, limit }) => {
  const [data, total] = await Promise.all([
    PartnerApplication.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    PartnerApplication.countDocuments(filter),
  ]);
  return { data, total };
};

/** Campus-scoped application (read). */
const findApplicationScoped = (id, campusFilter) =>
  PartnerApplication.findOne({ _id: id, ...campusFilter }).lean();

/** Applies fields to a campus-scoped application (review validated by the caller). */
const updateApplicationScoped = (id, campusFilter, set) =>
  PartnerApplication.findOneAndUpdate({ _id: id, ...campusFilter }, { $set: set }, { new: true }).lean();

/** Deletes a campus-scoped application. @returns {Promise<boolean>} */
const deleteApplicationScoped = async (id, campusFilter) => {
  const doc = await PartnerApplication.findOneAndDelete({ _id: id, ...campusFilter });
  return doc != null;
};

module.exports = {
  // partner — public resolution
  findActivePartnerByCode,
  findActivePartnerByCodeForResolve,
  findActivePartnerForPreRegister,
  incrementReferralHit,
  // partner — auth
  findPartnerByEmail,
  findPartnerByEmailExcluding,
  generatePartnerCode,
  createPartner,
  findPartnerByEmailWithPassword,
  findPartnerByEmailWithPasswordLean,
  findPartnerByIdWithPassword,
  setPartnerPassword,
  touchLoginActivity,
  touchActivity,
  // partner — profil
  findOwnProfile,
  findOwnProfileWithPassword,
  updateOwnProfile,
  updateOwnProfileImage,
  // partner — CRUD
  paginatePartners,
  findPartnerByIdScoped,
  findPartnerForKit,
  findPartnerSummaryFields,
  findPartnerForCommission,
  updatePartnerScoped,
  setPartnerStatusScoped,
  restorePartnerScoped,
  listPartnersForExport,
  // leads
  createLead,
  findActiveLeadByContact,
  findLeadByEmailOnCampus,
  findLeadByPhoneOnCampus,
  countRecentLeadsByIp,
  paginateLeads,
  findLeadScoped,
  findLeadForWrite,
  applyLeadStatus,
  updateLeadById,
  softAbandonLead,
  setLeadCommission,
  getLeadContact,
  listLeadsForExport,
  aggregateLeadConversionStats,
  aggregateLeadStatusStats,
  aggregateLeadSourceStats,
  aggregateLeadCountsByPartner,
  aggregateEnrolledCountsByPartner,
  listRecentLeadsForPartner,
  countLeadsForPartner,
  countEnrolledLeadsForPartner,
  // commissions
  findCommissionByLead,
  createCommission,
  paginateCommissions,
  findCommissionScoped,
  updateCommissionScoped,
  listCommissionsForExport,
  findPaidCommissionReceipt,
  listRecentCommissionsForPartner,
  countBlockingCommissions,
  aggregateCommissionStatusStats,
  // applications
  createApplication,
  paginateApplications,
  findApplicationScoped,
  updateApplicationScoped,
  deleteApplicationScoped,
};
