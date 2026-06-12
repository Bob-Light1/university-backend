'use strict';

/**
 * @file partner.crud.controller.js
 * @description CRUD partenaires pour les rôles Campus Manager / Admin / Director.
 *
 * Routes:
 *  GET    /api/partners                → listPartners
 *  GET    /api/partners/export         → exportPartners
 *  GET    /api/partners/:id            → getPartner
 *  PUT    /api/partners/:id            → updatePartner
 *  PATCH  /api/partners/:id/status     → toggleStatus
 *  DELETE /api/partners/:id            → archivePartner   (soft-delete)
 *  POST   /api/partners/:id/qr-code    → regenerateQR
 *  GET    /api/partners/:id/kit        → downloadKit
 *  GET    /api/partners/:id/commission-summary → getCommissionSummary
 *
 * Invariants :
 * • campusId toujours depuis JWT — jamais depuis URL params.
 * • Soft-delete guard : archive bloqué si commissions pending/validated.
 * • Computed stats (totalLeads, totalConverted) : countDocuments à chaque requête.
 * • Export : utilise le CSV util existant du projet.
 */

const mongoose = require('mongoose');
const path     = require('path');
const fs       = require('fs').promises;
const QRCode   = require('qrcode');

const Partner           = require('../models/partner.model');
const PartnerLead       = require('../models/partner.lead.model');
const PartnerCommission = require('../models/partner.commission.model');

const {
  asyncHandler,
  sendSuccess,
  sendError,
  sendCreated,
  sendPaginated,
  sendNotFound,
  sendForbidden,
} = require('../../../shared/utils/response-helpers');
const { isValidObjectId } = require('../../../shared/utils/validation-helpers');

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const UPLOAD_BASE  = process.env.UPLOAD_DIR
  ? path.join(process.env.UPLOAD_DIR)
  : path.join(__dirname, '..', '..', 'uploads');

// ── HELPERS ───────────────────────────────────────────────────────────────────

const isGlobalRole = (role) => role === 'ADMIN' || role === 'DIRECTOR';

const buildCampusFilter = (req) => {
  if (isGlobalRole(req.user.role)) return {};
  if (!req.user.campusId) {
    const err = new Error('Campus information not found in your account.');
    err.statusCode = 403;
    throw err;
  }
  return { schoolCampus: new mongoose.Types.ObjectId(req.user.campusId) };
};

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const generatePartnerQR = async (referralLink, campusId, partnerCode) => {
  const qrDir = path.join(UPLOAD_BASE, campusId.toString(), 'partners', 'qr');
  await fs.mkdir(qrDir, { recursive: true });

  const fileName = `qr_${partnerCode.toLowerCase()}.png`;
  const filePath = path.join(qrDir, fileName);

  const buffer = await QRCode.toBuffer(referralLink, {
    type:                 'png',
    width:                300,
    errorCorrectionLevel: 'M',
    margin:               2,
    color: { dark: '#000000', light: '#FFFFFF' },
  });

  await fs.writeFile(filePath, buffer);
  return fileName;
};

// ── LIST PARTNERS ─────────────────────────────────────────────────────────────

const listPartners = asyncHandler(async (req, res) => {
  const campusFilter = buildCampusFilter(req);

  // Filtre optionnel ?campusId= pour ADMIN/DIRECTOR
  if (isGlobalRole(req.user.role) && req.query.campusId) {
    if (!isValidObjectId(req.query.campusId)) return sendError(res, 400, 'Invalid campusId.');
    campusFilter.schoolCampus = new mongoose.Types.ObjectId(req.query.campusId);
  }

  const { status, partnerType, tier, channelType, search, page = 1, limit = 20 } = req.query;

  const filter = { ...campusFilter };
  if (status)      filter.status      = status;
  if (partnerType) filter.partnerType = partnerType;
  if (tier)        filter.tier        = tier;
  if (channelType) filter.channelType = channelType;

  if (search) {
    const re = { $regex: escapeRegex(search), $options: 'i' };
    filter.$or = [
      { firstName:    re },
      { lastName:     re },
      { organization: re },
      { partnerCode:  re },
      { email:        re },
    ];
  }

  const pageNum  = Math.max(1, parseInt(page,  10) || 1);
  const limitNum = Math.max(1, Math.min(parseInt(limit, 10) || 20, 100));

  const [partners, total] = await Promise.all([
    Partner.find(filter)
      .select('-password -__v')
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean({ virtuals: true }),
    Partner.countDocuments(filter),
  ]);

  // Computed stats : leads + converted par partenaire
  const ids = partners.map((p) => p._id);
  const [leadCounts, convertedCounts] = await Promise.all([
    PartnerLead.aggregate([
      { $match: { partner: { $in: ids }, honeypotTripped: false } },
      { $group: { _id: '$partner', count: { $sum: 1 } } },
    ]),
    PartnerLead.aggregate([
      { $match: { partner: { $in: ids }, status: 'enrolled', honeypotTripped: false } },
      { $group: { _id: '$partner', count: { $sum: 1 } } },
    ]),
  ]);

  const leadMap      = Object.fromEntries(leadCounts.map((x) => [x._id.toString(), x.count]));
  const convertedMap = Object.fromEntries(convertedCounts.map((x) => [x._id.toString(), x.count]));

  const enriched = partners.map((p) => ({
    ...p,
    totalLeads:     leadMap[p._id.toString()]      || 0,
    totalConverted: convertedMap[p._id.toString()] || 0,
  }));

  return sendPaginated(res, 200, 'Partners retrieved.', enriched, { total, page: pageNum, limit: limitNum });
});

// ── GET ONE PARTNER ───────────────────────────────────────────────────────────

const getPartner = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid partner ID.');

  const campusFilter = buildCampusFilter(req);
  const filter = { _id: new mongoose.Types.ObjectId(id), ...campusFilter };

  const partner = await Partner.findOne(filter)
    .select('-password -__v')
    .lean({ virtuals: true });

  if (!partner) return sendNotFound(res, 'Partner');

  const [totalLeads, totalConverted, pendingCommissions] = await Promise.all([
    PartnerLead.countDocuments({ partner: partner._id, honeypotTripped: false }),
    PartnerLead.countDocuments({ partner: partner._id, status: 'enrolled' }),
    PartnerCommission.countDocuments({ partner: partner._id, status: { $in: ['pending', 'validated'] } }),
  ]);

  return sendSuccess(res, 200, 'Partner retrieved.', {
    ...partner,
    totalLeads,
    totalConverted,
    pendingCommissions,
  });
});

// ── UPDATE PARTNER ────────────────────────────────────────────────────────────

const updatePartner = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid partner ID.');

  const campusFilter = buildCampusFilter(req);
  const filter = { _id: new mongoose.Types.ObjectId(id), ...campusFilter };

  // Champs que le gestionnaire peut modifier
  const managerFields = [
    'tier', 'status', 'convention', 'commissionConfig',
    'institutionType', 'commercialType', 'channelType',
  ];
  // Champs que le partenaire peut modifier (via son propre profil — pas utilisé ici)
  // Ici : seuls les rôles gestionnaires appellent ce contrôleur

  // Champs protégés — jamais mis à jour ici
  const PROTECTED = ['partnerCode', 'referralLink', 'qrCodeFileName', 'schoolCampus', 'createdBy', 'password'];

  const updates = {};
  for (const [key, val] of Object.entries(req.body)) {
    if (!PROTECTED.includes(key)) updates[key] = val;
  }

  if (Object.keys(updates).length === 0) {
    return sendError(res, 400, 'No updatable fields provided.');
  }

  // Vérifier email uniqueness si l'email est changé
  if (updates.email) {
    updates.email = updates.email.toLowerCase().trim();
    const taken = await Partner.findOne({ email: updates.email, _id: { $ne: id } }).lean();
    if (taken) return sendError(res, 409, 'Email already in use.');
  }

  // Bloquer archive via update direct si commissions pending/validated
  if (updates.status === 'archived') {
    const blocking = await PartnerCommission.countDocuments({
      partner: new mongoose.Types.ObjectId(id),
      status:  { $in: ['pending', 'validated'] },
    });
    if (blocking > 0) {
      return sendForbidden(res, `Cannot archive: ${blocking} unresolved commission(s) must be paid or cancelled first.`);
    }
  }

  const updated = await Partner.findOneAndUpdate(
    filter,
    { $set: updates },
    { new: true, runValidators: true }
  ).select('-password -__v').lean({ virtuals: true });

  if (!updated) return sendNotFound(res, 'Partner');

  return sendSuccess(res, 200, 'Partner updated.', updated);
});

// ── TOGGLE STATUS ─────────────────────────────────────────────────────────────

const toggleStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid partner ID.');

  const VALID_STATUSES = ['active', 'inactive', 'suspended', 'archived'];
  if (!VALID_STATUSES.includes(status)) {
    return sendError(res, 400, `status must be one of: ${VALID_STATUSES.join(', ')}.`);
  }

  const campusFilter = buildCampusFilter(req);
  const filter = { _id: new mongoose.Types.ObjectId(id), ...campusFilter };

  if (status === 'archived') {
    const blocking = await PartnerCommission.countDocuments({
      partner: new mongoose.Types.ObjectId(id),
      status:  { $in: ['pending', 'validated'] },
    });
    if (blocking > 0) {
      return sendForbidden(res, `Cannot archive: ${blocking} unresolved commission(s) must be paid or cancelled first.`);
    }
  }

  const updated = await Partner.findOneAndUpdate(
    filter,
    { $set: { status } },
    { new: true }
  ).select('-password -__v').lean({ virtuals: true });

  if (!updated) return sendNotFound(res, 'Partner');

  return sendSuccess(res, 200, `Partner status set to '${status}'.`, updated);
});

// ── ARCHIVE (soft-delete) ─────────────────────────────────────────────────────

const archivePartner = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid partner ID.');

  const blocking = await PartnerCommission.countDocuments({
    partner: new mongoose.Types.ObjectId(id),
    status:  { $in: ['pending', 'validated'] },
  });
  if (blocking > 0) {
    return sendForbidden(res, `Cannot archive: ${blocking} unresolved commission(s) must be paid or cancelled first.`);
  }

  const campusFilter = buildCampusFilter(req);
  const updated = await Partner.findOneAndUpdate(
    { _id: new mongoose.Types.ObjectId(id), ...campusFilter },
    { $set: { status: 'archived' } },
    { new: true }
  ).select('-password -__v').lean({ virtuals: true });

  if (!updated) return sendNotFound(res, 'Partner');

  return sendSuccess(res, 200, 'Partner archived.', updated);
});

// ── RESTORE (undo archive) ────────────────────────────────────────────────────

const restorePartner = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid partner ID.');

  const campusFilter = buildCampusFilter(req);
  const updated = await Partner.findOneAndUpdate(
    { _id: new mongoose.Types.ObjectId(id), ...campusFilter, status: 'archived' },
    { $set: { status: 'active' } },
    { new: true }
  ).select('-password -__v').lean({ virtuals: true });

  if (!updated) return sendNotFound(res, 'Partner (archived)');

  return sendSuccess(res, 200, 'Partner restored.', updated);
});

// ── REGENERATE QR ─────────────────────────────────────────────────────────────

const regenerateQR = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid partner ID.');

  const campusFilter = buildCampusFilter(req);
  const partner = await Partner.findOne({ _id: new mongoose.Types.ObjectId(id), ...campusFilter });

  if (!partner) return sendNotFound(res, 'Partner');
  if (!partner.partnerCode) return sendError(res, 400, 'Partner has no partnerCode — cannot generate QR.');

  const qrCodeFileName = await generatePartnerQR(
    partner.referralLink,
    partner.schoolCampus,
    partner.partnerCode
  );

  partner.qrCodeFileName = qrCodeFileName;
  await partner.save();

  return sendSuccess(res, 200, 'QR code regenerated.', { qrCodeFileName });
});

// ── DOWNLOAD KIT (PDF flyer + QR) ────────────────────────────────────────────

const downloadKit = asyncHandler(async (req, res) => {
  // On the /me/kit route there is no :id param → fall back to the authenticated partner.
  const id = req.params.id || req.user.id;
  const { type = 'qr' } = req.query; // qr | pdf | message

  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid partner ID.');

  const campusFilter = buildCampusFilter(req);
  const partner = await Partner.findOne({ _id: new mongoose.Types.ObjectId(id), ...campusFilter })
    .select('-password')
    .lean({ virtuals: true });

  if (!partner) return sendNotFound(res, 'Partner');
  if (!partner.partnerCode) return sendError(res, 400, 'Partner has no partnerCode.');

  if (type === 'qr') {
    const qrFilePath = path.join(
      UPLOAD_BASE,
      partner.schoolCampus.toString(),
      'partners', 'qr',
      partner.qrCodeFileName || `qr_${partner.partnerCode.toLowerCase()}.png`
    );
    try {
      await fs.access(qrFilePath);
    } catch {
      return sendError(res, 404, 'QR file not found. Please regenerate it.');
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="kit_${partner.partnerCode}.png"`);
    const buffer = await fs.readFile(qrFilePath);
    return res.end(buffer);
  }

  if (type === 'message') {
    // Modèle de message WhatsApp pré-composé
    const campusName = 'Notre Campus'; // TODO: populate campus name
    const message = `Bonjour ! Je m'appelle ${partner.firstName} ${partner.lastName} et je vous invite à vous pré-inscrire à ${campusName}.\n\nUtilisez mon lien : ${partner.referralLink}\n\nOu mon code : ${partner.partnerCode}`;
    return sendSuccess(res, 200, 'Message template retrieved.', { message });
  }

  if (type === 'pdf') {
    // TODO P2: Générer le flyer PDF via puppeteer-core (même pattern que academic-pdf.service.js)
    return sendError(res, 501, 'PDF flyer generation not yet implemented in this build.');
  }

  return sendError(res, 400, "type must be 'qr', 'pdf', or 'message'.");
});

// ── EXPORT ────────────────────────────────────────────────────────────────────

const exportPartners = asyncHandler(async (req, res) => {
  const campusFilter = buildCampusFilter(req);

  if (isGlobalRole(req.user.role) && req.query.campusId) {
    if (!isValidObjectId(req.query.campusId)) return sendError(res, 400, 'Invalid campusId.');
    campusFilter.schoolCampus = new mongoose.Types.ObjectId(req.query.campusId);
  }

  const { status, partnerType, tier, format = 'csv' } = req.query;
  const filter = { ...campusFilter };
  if (status)      filter.status      = status;
  if (partnerType) filter.partnerType = partnerType;
  if (tier)        filter.tier        = tier;

  const partners = await Partner.find(filter)
    .select('firstName lastName email partnerType tier partnerCode status organization createdAt')
    .sort({ createdAt: -1 })
    .lean();

  const rows = partners.map((p) => ({
    'First Name':    p.firstName,
    'Last Name':     p.lastName,
    'Email':         p.email,
    'Type':          p.partnerType,
    'Tier':          p.tier,
    'Code':          p.partnerCode || '',
    'Organization':  p.organization || '',
    'Status':        p.status,
    'Created At':    p.createdAt ? new Date(p.createdAt).toISOString().slice(0, 10) : '',
  }));

  if (format === 'csv') {
    const headers = Object.keys(rows[0] || {});
    const csvRows = [
      headers.join(','),
      ...rows.map((r) => headers.map((h) => `"${String(r[h] || '').replace(/"/g, '""')}"`).join(',')),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="partners_export.csv"');
    return res.end(csvRows.join('\n'));
  }

  // JSON fallback (xlsx deferred — utiliser le util existant quand disponible)
  return sendSuccess(res, 200, 'Export data retrieved.', rows);
});

// ── COMMISSION SUMMARY ────────────────────────────────────────────────────────

const getCommissionSummary = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid partner ID.');

  const campusFilter = buildCampusFilter(req);
  const partner = await Partner.findOne({ _id: new mongoose.Types.ObjectId(id), ...campusFilter })
    .select('_id firstName lastName partnerCode')
    .lean();

  if (!partner) return sendNotFound(res, 'Partner');

  const [leadStats, commissionStats] = await Promise.all([
    PartnerLead.aggregate([
      { $match: { partner: partner._id, honeypotTripped: false } },
      { $group: {
          _id:       null,
          total:     { $sum: 1 },
          enrolled:  { $sum: { $cond: [{ $eq: ['$status', 'enrolled'] }, 1, 0] } },
      }},
    ]),
    PartnerCommission.aggregate([
      { $match: { partner: partner._id } },
      { $group: {
          _id:      '$status',
          count:    { $sum: 1 },
          totalAmt: { $sum: '$amount' },
      }},
    ]),
  ]);

  const leads = leadStats[0] || { total: 0, enrolled: 0 };
  const conversionRate = leads.total > 0
    ? Math.round((leads.enrolled / leads.total) * 100)
    : 0;

  const commissionByStatus = Object.fromEntries(
    commissionStats.map((c) => [c._id, { count: c.count, totalAmount: c.totalAmt }])
  );

  return sendSuccess(res, 200, 'Commission summary retrieved.', {
    partner: { id: partner._id, firstName: partner.firstName, lastName: partner.lastName, partnerCode: partner.partnerCode },
    leads:   { total: leads.total, enrolled: leads.enrolled, conversionRate },
    commissions: commissionByStatus,
  });
});

// ── EXPORTS ───────────────────────────────────────────────────────────────────

module.exports = {
  listPartners,
  getPartner,
  updatePartner,
  toggleStatus,
  archivePartner,
  restorePartner,
  regenerateQR,
  downloadKit,
  exportPartners,
  getCommissionSummary,
};
