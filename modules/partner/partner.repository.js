'use strict';

/**
 * @file partner.repository.js — couche de persistance du domaine partner.
 *
 * SEUL fichier du module autorisé à interroger les 4 models partner directement
 * (Partner, PartnerLead, PartnerCommission, PartnerApplication), pour les 4
 * controllers (auth, crud, commission, lead) ET le service inter-modules.
 * Étape 0 de la préparation Postgres — voir POSTGRES_MIGRATION_ASSESSMENT.md §7.
 *
 * Conventions :
 *  - lectures → .lean() (objets simples) ; les vues exposées au front conservent
 *    .lean({ virtuals: true }) (fullName) à l'identique des handlers d'origine.
 *  - écritures partenaire → le model Partner a un hook pre('save') qui hash le
 *    password : la CRÉATION passe par load→save (new Partner + save) pour le
 *    déclencher ; les mises à jour de champs non sensibles passent par
 *    findOneAndUpdate atomique (aucun hook concerné) ; le password est toujours
 *    hashé manuellement par le controller puis posé via setPartnerPassword.
 *  - Lead / Commission / Application n'ont AUCUN hook pre/post (seulement un
 *    virtual fullName) → mutations atomiques ; les préconditions métier (statut,
 *    transition, doublon) restent dans l'appelant via une lecture lean préalable.
 *  - les pipelines d'agrégation vivent ici ; l'appelant fournit le $match (déjà
 *    casté en ObjectId) et le repo détient les étapes $group.
 *  - le scoping campus ({ schoolCampus } | {}) est construit par l'appelant et
 *    passé en paramètre (campusFilter).
 *
 * NB : la config de commission est embarquée dans le model Campus (autre module).
 * Le controller commission y accède via campus.service (require paresseux), pas
 * via ce repository — voir campus.repository.getCampusCommissionConfigWithName /
 * setCampusCommissionConfig.
 */

const Partner           = require('./models/partner.model');
const PartnerLead       = require('./models/partner.lead.model');
const PartnerCommission = require('./models/partner.commission.model');
const PartnerApplication = require('./models/partner.application.model');

// Projection « sûre » d'un partenaire exposé au front (sans secret).
const SAFE = '-password -__v';

const normCode = (code) => String(code).toUpperCase().trim();

// ── PARTNER : résolution publique par code ─────────────────────────────────────

/** Partenaire ACTIF par code de parrainage (service inter-modules). */
const findActivePartnerByCode = (code) =>
  Partner.findOne({ partnerCode: normCode(code), status: 'active' })
    .select('_id email schoolCampus partnerCode').lean();

/** Idem + branding campus peuplé (page publique de pré-inscription). */
const findActivePartnerByCodeForResolve = (code) =>
  Partner.findOne({ partnerCode: normCode(code), status: 'active' })
    .select('partnerCode firstName lastName schoolCampus')
    .populate('schoolCampus', 'campus_name logo primaryColor')
    .lean();

/** Idem + config de commission (soumission de pré-inscription publique). */
const findActivePartnerForPreRegister = (code) =>
  Partner.findOne({ partnerCode: normCode(code), status: 'active' })
    .select('_id email schoolCampus partnerCode commissionConfig tier').lean();

// ── PARTNER : auth ─────────────────────────────────────────────────────────────

/** Recherche par email (contrôle d'unicité à la création). */
const findPartnerByEmail = (email) => Partner.findOne({ email }).lean();

/** Email pris par un AUTRE partenaire (contrôle d'unicité à la mise à jour). */
const findPartnerByEmailExcluding = (email, id) =>
  Partner.findOne({ email, _id: { $ne: id } }).lean();

/** Génère un partnerCode unique (statique du model). */
const generatePartnerCode = (lastName, firstName, country, year) =>
  Partner.generatePartnerCode(lastName, firstName, country, year);

/** Crée un partenaire — load→save pour déclencher le hash pre('save'). @returns {Promise<Document>} */
const createPartner = async (data) => {
  const partner = new Partner(data);
  await partner.save();
  return partner;
};

/** Login : document AVEC le hash (méthode d'instance comparePassword + toObject). */
const findPartnerByEmailWithPassword = (email) =>
  Partner.findOne({ email }).select('+password');

/** Mot de passe oublié : lecture lean AVEC le hash (sert de nonce au token). */
const findPartnerByEmailWithPasswordLean = (email) =>
  Partner.findOne({ email }).select('+password').lean();

/** Réinitialisation : document AVEC le hash (vérification du nonce). */
const findPartnerByIdWithPassword = (id) =>
  Partner.findById(id).select('+password');

/** Pose un mot de passe déjà hashé. */
const setPartnerPassword = (id, hashedPassword) =>
  Partner.findByIdAndUpdate(id, { password: hashedPassword });

/** Login : horodate lastLoginAt + lastActivityAt (fire-and-forget, .exec()). */
const touchLoginActivity = (id) =>
  Partner.findByIdAndUpdate(id, { lastLoginAt: new Date(), lastActivityAt: new Date() }).exec();

/** Pré-inscription : horodate lastActivityAt (fire-and-forget, .exec()). */
const touchActivity = (id) =>
  Partner.findByIdAndUpdate(id, { lastActivityAt: new Date() }).exec();

// ── PARTNER : profil (self-service PARTNER) ───────────────────────────────────

/** Profil du partenaire connecté (scopé campus). */
const findOwnProfile = (id, campusId) =>
  Partner.findOne({ _id: id, schoolCampus: campusId }).select(SAFE).lean({ virtuals: true });

/** Profil du partenaire connecté AVEC le hash (changement de mot de passe). */
const findOwnProfileWithPassword = (id, campusId) =>
  Partner.findOne({ _id: id, schoolCampus: campusId }).select('+password');

/** Met à jour les champs éditables par le partenaire lui-même. */
const updateOwnProfile = (id, campusId, updates) =>
  Partner.findOneAndUpdate(
    { _id: id, schoolCampus: campusId },
    { $set: updates },
    { new: true, runValidators: true }
  ).select(SAFE).lean({ virtuals: true });

/** Met à jour l'image de profil. */
const updateOwnProfileImage = (id, campusId, profileImage) =>
  Partner.findOneAndUpdate(
    { _id: id, schoolCampus: campusId },
    { $set: { profileImage } },
    { new: true }
  ).select('_id firstName lastName profileImage').lean({ virtuals: true });

// ── PARTNER : CRUD back-office ────────────────────────────────────────────────

/**
 * Liste paginée des partenaires (filtre déjà construit par l'appelant).
 * @returns {Promise<{data, total}>}
 */
const paginatePartners = async (filter, { skip, limit }) => {
  const [data, total] = await Promise.all([
    Partner.find(filter).select(SAFE).sort({ createdAt: -1 }).skip(skip).limit(limit).lean({ virtuals: true }),
    Partner.countDocuments(filter),
  ]);
  return { data, total };
};

/** Partenaire scopé campus, projection sûre (getPartner). */
const findPartnerByIdScoped = (id, campusFilter) =>
  Partner.findOne({ _id: id, ...campusFilter }).select(SAFE).lean({ virtuals: true });

/** Document partenaire scopé campus (regenerateQR : mutation + save). @returns {Promise<Document|null>} */
const findPartnerDocByIdScoped = (id, campusFilter) =>
  Partner.findOne({ _id: id, ...campusFilter });

/** Partenaire scopé campus pour le kit (sans password, virtuals). */
const findPartnerForKit = (id, campusFilter) =>
  Partner.findOne({ _id: id, ...campusFilter }).select('-password').lean({ virtuals: true });

/** Champs d'identité du partenaire (résumé commissions). */
const findPartnerSummaryFields = (id, campusFilter) =>
  Partner.findOne({ _id: id, ...campusFilter }).select('_id firstName lastName partnerCode').lean();

/** Config de commission/tier d'un partenaire (moteur de commission). */
const findPartnerForCommission = (partnerId) =>
  Partner.findById(partnerId).select('commissionConfig tier schoolCampus').lean();

/** Régénère le QR : applique qrCodeFileName via save (cf. findPartnerDocByIdScoped). */
const savePartnerDoc = (partner) => partner.save();

/** Met à jour un partenaire scopé (champs gestionnaire, runValidators). */
const updatePartnerScoped = (id, campusFilter, updates) =>
  Partner.findOneAndUpdate(
    { _id: id, ...campusFilter },
    { $set: updates },
    { new: true, runValidators: true }
  ).select(SAFE).lean({ virtuals: true });

/** Change le statut d'un partenaire scopé. */
const setPartnerStatusScoped = (id, campusFilter, status) =>
  Partner.findOneAndUpdate(
    { _id: id, ...campusFilter },
    { $set: { status } },
    { new: true }
  ).select(SAFE).lean({ virtuals: true });

/** Restaure un partenaire archivé (status archived → active). */
const restorePartnerScoped = (id, campusFilter) =>
  Partner.findOneAndUpdate(
    { _id: id, ...campusFilter, status: 'archived' },
    { $set: { status: 'active' } },
    { new: true }
  ).select(SAFE).lean({ virtuals: true });

/** Export partenaires (filtre déjà construit). */
const listPartnersForExport = (filter) =>
  Partner.find(filter)
    .select('firstName lastName email partnerType tier partnerCode status organization createdAt')
    .sort({ createdAt: -1 }).lean();

// ── LEADS ──────────────────────────────────────────────────────────────────────

/** Crée un lead (pas de hook). @returns {Promise<Document>} */
const createLead = async (data) => {
  const lead = new PartnerLead(data);
  await lead.save();
  return lead;
};

/** Lead actif (non honeypot) par email/téléphone sur un campus (déduplication). */
const findActiveLeadByContact = ({ campusId, dupOr }) =>
  PartnerLead.findOne({ schoolCampus: campusId, honeypotTripped: false, $or: dupOr }).lean();

/** Lead par email sur un campus (opt-in alerte). */
const findLeadByEmailOnCampus = (email, campusId) =>
  PartnerLead.findOne({ email, schoolCampus: campusId }).lean();

/** Lead par téléphone sur un campus (opt-in alerte). */
const findLeadByPhoneOnCampus = (phone, campusId) =>
  PartnerLead.findOne({ phone, schoolCampus: campusId }).lean();

/** Compte les leads d'un même IP hash depuis `since` (détection IP_BURST). */
const countRecentLeadsByIp = ({ ipAddressHash, since }) =>
  PartnerLead.countDocuments({ ipAddressHash, createdAt: { $gte: since }, honeypotTripped: false });

/**
 * Liste paginée des leads (filtre déjà construit, partenaire peuplé).
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

/** Lead unitaire scopé (filtre construit par l'appelant, partenaire peuplé). */
const findLeadScoped = (filter) =>
  PartnerLead.findOne(filter).populate('partner', 'firstName lastName partnerCode tier').lean({ virtuals: true });

/** Lead non honeypot scopé campus, lecture lean (précondition transition/suppression). */
const findLeadForWrite = (id, campusFilter) =>
  PartnerLead.findOne({ _id: id, honeypotTripped: false, ...campusFilter }).lean();

/** Avance le statut d'un lead + historise (transition validée par l'appelant). */
const applyLeadStatus = (id, campusFilter, status, historyEntry) =>
  PartnerLead.findOneAndUpdate(
    { _id: id, honeypotTripped: false, ...campusFilter },
    { $set: { status }, $push: { statusHistory: historyEntry } },
    { new: true }
  ).lean({ virtuals: true });

/** Met à jour des champs d'un lead, historisation optionnelle (dédup / opt-in). */
const updateLeadById = (id, set, historyEntry = null) => {
  const update = { $set: set };
  if (historyEntry) update.$push = { statusHistory: historyEntry };
  return PartnerLead.findByIdAndUpdate(id, update);
};

/** Marque un lead abandonné + historise (soft-delete). */
const softAbandonLead = (id, historyEntry) =>
  PartnerLead.findByIdAndUpdate(id, { $set: { status: 'abandoned' }, $push: { statusHistory: historyEntry } });

/** Rattache la commission générée au lead. */
const setLeadCommission = (leadId, commissionId) =>
  PartnerLead.findByIdAndUpdate(leadId, { commissionId });

/** Coordonnées d'un lead pour notification (service inter-modules). */
const getLeadContact = (leadId) =>
  PartnerLead.findById(leadId).select('firstName email phone').lean();

/** Export leads (filtre déjà construit, partenaire peuplé). */
const listLeadsForExport = (filter) =>
  PartnerLead.find(filter)
    .populate('partner', 'firstName lastName partnerCode')
    .select('firstName lastName email phone programInterest source status partnerCode createdAt')
    .sort({ createdAt: -1 }).lean();

/** Agrégat total/convertis pour un partenaire ($match fourni). */
const aggregateLeadConversionStats = (matchFilter) =>
  PartnerLead.aggregate([
    { $match: matchFilter },
    { $group: {
      _id:      null,
      total:    { $sum: 1 },
      enrolled: { $sum: { $cond: [{ $eq: ['$status', 'enrolled'] }, 1, 0] } },
    } },
  ]);

/** Nombre de leads (non honeypot) par partenaire, pour une liste d'ids. */
const aggregateLeadCountsByPartner = (ids) =>
  PartnerLead.aggregate([
    { $match: { partner: { $in: ids }, honeypotTripped: false } },
    { $group: { _id: '$partner', count: { $sum: 1 } } },
  ]);

/** Nombre de leads convertis (enrolled) par partenaire, pour une liste d'ids. */
const aggregateEnrolledCountsByPartner = (ids) =>
  PartnerLead.aggregate([
    { $match: { partner: { $in: ids }, status: 'enrolled', honeypotTripped: false } },
    { $group: { _id: '$partner', count: { $sum: 1 } } },
  ]);

/** Leads récents d'un partenaire (dashboard). */
const listRecentLeadsForPartner = ({ partnerId, campusId, limit }) =>
  PartnerLead.find({ partner: partnerId, schoolCampus: campusId, honeypotTripped: false })
    .select('firstName lastName source status createdAt')
    .sort({ createdAt: -1 }).limit(limit).lean();

/** Comptes leads (non honeypot) d'un partenaire. */
const countLeadsForPartner = (partnerId) =>
  PartnerLead.countDocuments({ partner: partnerId, honeypotTripped: false });

/** Comptes leads convertis (enrolled) d'un partenaire. */
const countEnrolledLeadsForPartner = (partnerId) =>
  PartnerLead.countDocuments({ partner: partnerId, status: 'enrolled' });

// ── COMMISSIONS ──────────────────────────────────────────────────────────────

/** Commission existante pour un lead (idempotence du moteur). */
const findCommissionByLead = (leadId) =>
  PartnerCommission.findOne({ lead: leadId }).lean();

/** Crée une commission (pas de hook). @returns {Promise<Document>} */
const createCommission = async (data) => {
  const commission = new PartnerCommission(data);
  await commission.save();
  return commission;
};

/**
 * Liste paginée des commissions (filtre déjà construit, partner + lead peuplés).
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

/** Commission scopée campus, lecture lean (précondition de transition). */
const findCommissionScoped = (id, campusFilter) =>
  PartnerCommission.findOne({ _id: id, ...campusFilter }).lean();

/** Applique des champs à une commission scopée (transition validée par l'appelant). */
const updateCommissionScoped = (id, campusFilter, set) =>
  PartnerCommission.findOneAndUpdate({ _id: id, ...campusFilter }, { $set: set }, { new: true }).lean();

/** Export commissions (filtre déjà construit, partner + lead peuplés). */
const listCommissionsForExport = (filter) =>
  PartnerCommission.find(filter)
    .populate('partner', 'firstName lastName partnerCode')
    .populate('lead',    'firstName lastName email')
    .sort({ createdAt: -1 }).lean();

/** Reçu : commission PAYÉE du partenaire connecté (partner + lead peuplés). */
const findPaidCommissionReceipt = ({ id, partnerId, campusId }) =>
  PartnerCommission.findOne({ _id: id, partner: partnerId, schoolCampus: campusId, status: 'paid' })
    .populate('partner', 'firstName lastName partnerCode')
    .populate('lead',    'firstName lastName email')
    .lean();

/** Commissions récentes d'un partenaire (dashboard). */
const listRecentCommissionsForPartner = ({ partnerId, campusId, limit }) =>
  PartnerCommission.find({ partner: partnerId, schoolCampus: campusId })
    .select('amount currency status paymentChannel createdAt')
    .sort({ createdAt: -1 }).limit(limit).lean();

/** Commissions bloquantes (pending/validated) d'un partenaire (garde d'archivage). */
const countBlockingCommissions = (partnerId) =>
  PartnerCommission.countDocuments({ partner: partnerId, status: { $in: ['pending', 'validated'] } });

/** Agrégat des commissions groupées par statut ($match fourni). */
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

/** Crée une candidature. @returns {Promise<Document>} */
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

/** Candidature scopée campus (lecture). */
const findApplicationScoped = (id, campusFilter) =>
  PartnerApplication.findOne({ _id: id, ...campusFilter }).lean();

/** Applique des champs à une candidature scopée (revue validée par l'appelant). */
const updateApplicationScoped = (id, campusFilter, set) =>
  PartnerApplication.findOneAndUpdate({ _id: id, ...campusFilter }, { $set: set }, { new: true }).lean();

/** Supprime une candidature scopée. @returns {Promise<boolean>} */
const deleteApplicationScoped = async (id, campusFilter) => {
  const doc = await PartnerApplication.findOneAndDelete({ _id: id, ...campusFilter });
  return doc != null;
};

module.exports = {
  // partner — résolution publique
  findActivePartnerByCode,
  findActivePartnerByCodeForResolve,
  findActivePartnerForPreRegister,
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
  findPartnerDocByIdScoped,
  findPartnerForKit,
  findPartnerSummaryFields,
  findPartnerForCommission,
  savePartnerDoc,
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
