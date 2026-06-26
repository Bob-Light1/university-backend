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
const QRCode   = require('qrcode');

const partnerRepo = require('../partner.repository');

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
const { buildReferralUrl } = require('../../../shared/utils/referral');

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

/**
 * Builds a CSV cell, neutralizing spreadsheet formula injection.
 * A leading =, +, -, @, tab or CR is prefixed with a single quote so Excel /
 * Google Sheets treat it as text (OWASP CSV Injection).
 */
const csvCell = (value) => {
  const s = String(value ?? '');
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

/**
 * Normalizes a convention sub-document from the client: drops empty-string fields
 * so optional Date / Number / enum fields don't trip casting or enum validation.
 * Returns null when nothing meaningful is provided.
 */
const normalizeConvention = (conv) => {
  if (!conv || typeof conv !== 'object') return null;
  const out = {};
  for (const key of ['startDate', 'endDate', 'commissionType', 'currency', 'status', 'notes', 'documentUrl']) {
    if (conv[key] !== undefined && conv[key] !== null && conv[key] !== '') out[key] = conv[key];
  }
  if (conv.commissionValue !== undefined && conv.commissionValue !== null && conv.commissionValue !== '') {
    out.commissionValue = conv.commissionValue;
  }
  return Object.keys(out).length ? out : null;
};

/**
 * Normalizes a per-partner commission override. Returns null when no ruleType is
 * selected (engine falls back to the campus config). Keeps only the amount
 * relevant to the chosen rule.
 */
const normalizeCommissionConfig = (cfg) => {
  if (!cfg || typeof cfg !== 'object' || !cfg.ruleType) return null;
  if (!['FIXED', 'PERCENTAGE'].includes(cfg.ruleType)) return null;
  const out = { ruleType: cfg.ruleType };
  if (cfg.ruleType === 'FIXED') {
    out.fixedAmount = Number(cfg.fixedAmount) || 0;
  } else {
    out.percentage = Number(cfg.percentage) || 0;
  }
  if (cfg.currency) out.currency = cfg.currency;
  return out;
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

  const { data: partners, total } = await partnerRepo.paginatePartners(filter, {
    skip: (pageNum - 1) * limitNum,
    limit: limitNum,
  });

  // Computed stats : leads + converted par partenaire
  const ids = partners.map((p) => p._id);
  const [leadCounts, convertedCounts] = await Promise.all([
    partnerRepo.aggregateLeadCountsByPartner(ids),
    partnerRepo.aggregateEnrolledCountsByPartner(ids),
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

  const partner = await partnerRepo.findPartnerByIdScoped(new mongoose.Types.ObjectId(id), campusFilter);

  if (!partner) return sendNotFound(res, 'Partner');

  const [totalLeads, totalConverted, pendingCommissions] = await Promise.all([
    partnerRepo.countLeadsForPartner(partner._id),
    partnerRepo.countEnrolledLeadsForPartner(partner._id),
    partnerRepo.countBlockingCommissions(partner._id),
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

  // Champs que le gestionnaire peut modifier
  const managerFields = [
    'tier', 'status', 'convention', 'commissionConfig',
    'institutionType', 'commercialType', 'channelType',
  ];
  // Fields the partner can edit (via their own profile — not used here)
  // Here: only manager roles call this controller

  // Protected fields — never updated here
  const PROTECTED = ['partnerCode', 'referralLink', 'qrCodeFileName', 'schoolCampus', 'createdBy', 'password'];

  const updates = {};
  for (const [key, val] of Object.entries(req.body)) {
    // Normalize empty strings to null so optional enum fields (gender,
    // institutionType, commercialType, channelType…) don't fail enum validation.
    if (!PROTECTED.includes(key)) updates[key] = val === '' ? null : val;
  }

  // Convention is a nested sub-document — sanitize its own empty-string fields.
  if (updates.convention !== undefined) {
    updates.convention = normalizeConvention(updates.convention);
  }

  // Per-partner commission override — null clears it (back to campus default).
  if (updates.commissionConfig !== undefined) {
    updates.commissionConfig = normalizeCommissionConfig(updates.commissionConfig);
  }

  if (Object.keys(updates).length === 0) {
    return sendError(res, 400, 'No updatable fields provided.');
  }

  // Check email uniqueness if the email is changed
  if (updates.email) {
    updates.email = updates.email.toLowerCase().trim();
    const taken = await partnerRepo.findPartnerByEmailExcluding(updates.email, id);
    if (taken) return sendError(res, 409, 'Email already in use.');
  }

  // Bloquer archive via update direct si commissions pending/validated
  if (updates.status === 'archived') {
    const blocking = await partnerRepo.countBlockingCommissions(new mongoose.Types.ObjectId(id));
    if (blocking > 0) {
      return sendForbidden(res, `Cannot archive: ${blocking} unresolved commission(s) must be paid or cancelled first.`);
    }
  }

  const updated = await partnerRepo.updatePartnerScoped(new mongoose.Types.ObjectId(id), campusFilter, updates);

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

  if (status === 'archived') {
    const blocking = await partnerRepo.countBlockingCommissions(new mongoose.Types.ObjectId(id));
    if (blocking > 0) {
      return sendForbidden(res, `Cannot archive: ${blocking} unresolved commission(s) must be paid or cancelled first.`);
    }
  }

  const updated = await partnerRepo.setPartnerStatusScoped(new mongoose.Types.ObjectId(id), campusFilter, status);

  if (!updated) return sendNotFound(res, 'Partner');

  return sendSuccess(res, 200, `Partner status set to '${status}'.`, updated);
});

// ── ARCHIVE (soft-delete) ─────────────────────────────────────────────────────

const archivePartner = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid partner ID.');

  const blocking = await partnerRepo.countBlockingCommissions(new mongoose.Types.ObjectId(id));
  if (blocking > 0) {
    return sendForbidden(res, `Cannot archive: ${blocking} unresolved commission(s) must be paid or cancelled first.`);
  }

  const campusFilter = buildCampusFilter(req);
  const updated = await partnerRepo.setPartnerStatusScoped(new mongoose.Types.ObjectId(id), campusFilter, 'archived');

  if (!updated) return sendNotFound(res, 'Partner');

  return sendSuccess(res, 200, 'Partner archived.', updated);
});

// ── RESTORE (undo archive) ────────────────────────────────────────────────────

const restorePartner = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid partner ID.');

  const campusFilter = buildCampusFilter(req);
  const updated = await partnerRepo.restorePartnerScoped(new mongoose.Types.ObjectId(id), campusFilter);

  if (!updated) return sendNotFound(res, 'Partner (archived)');

  return sendSuccess(res, 200, 'Partner restored.', updated);
});

// ── DOWNLOAD KIT (PDF flyer + QR) ────────────────────────────────────────────

const downloadKit = asyncHandler(async (req, res) => {
  // On the /me/kit route there is no :id param → fall back to the authenticated partner.
  const id = req.params.id || req.user.id;
  const { type = 'qr' } = req.query; // qr | pdf | message

  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid partner ID.');

  const campusFilter = buildCampusFilter(req);
  const partner = await partnerRepo.findPartnerForKit(new mongoose.Types.ObjectId(id), campusFilter);

  if (!partner) return sendNotFound(res, 'Partner');
  if (!partner.partnerCode) return sendError(res, 400, 'Partner has no partnerCode.');

  if (type === 'qr') {
    // Generated on the fly from the partnerCode — no disk, survives redeploys.
    const buffer = await QRCode.toBuffer(
      buildReferralUrl(partner.partnerCode, { src: 'qr' }),
      { type: 'png', width: 300, errorCorrectionLevel: 'M', margin: 2, color: { dark: '#000000', light: '#FFFFFF' } }
    );
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="kit_${partner.partnerCode}.png"`);
    return res.end(buffer);
  }

  if (type === 'message') {
    // Pre-composed WhatsApp message template
    const campus = await require('../../campus').service.getCampusName(partner.schoolCampus).catch(() => null);
    const campusName = campus?.campus_name || 'our school';
    const message = `Hi! I'm ${partner.firstName} ${partner.lastName} and I'd like to invite you to pre-register at ${campusName}.\n\nUse my link: ${partner.referralLink}\n\nOr my code: ${partner.partnerCode}`;
    return sendSuccess(res, 200, 'Message template retrieved.', { message });
  }

  if (type === 'pdf') {
    const campus = await require('../../campus').service.getCampusName(partner.schoolCampus).catch(() => null);
    const pdfBuffer = await require('../partner.pdf.service').generatePartnerFlyerPdf(
      partner,
      { campusName: campus?.campus_name },
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="kit_${partner.partnerCode}.pdf"`);
    return res.end(pdfBuffer);
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

  const partners = await partnerRepo.listPartnersForExport(filter);

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
      ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(',')),
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
  const partner = await partnerRepo.findPartnerSummaryFields(new mongoose.Types.ObjectId(id), campusFilter);

  if (!partner) return sendNotFound(res, 'Partner');

  const [leadStats, commissionStats] = await Promise.all([
    partnerRepo.aggregateLeadConversionStats({ partner: partner._id, honeypotTripped: false }),
    partnerRepo.aggregateCommissionStatusStats({ partner: partner._id }),
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
  downloadKit,
  exportPartners,
  getCommissionSummary,
};
