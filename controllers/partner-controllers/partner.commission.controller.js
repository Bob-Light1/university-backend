'use strict';

/**
 * @file partner.commission.controller.js
 * @description Gestion des commissions partenaires.
 *
 * Routes:
 *  GET    /api/partners/commissions                  → listCommissions
 *  GET    /api/partners/commissions/export           → exportCommissions
 *  PATCH  /api/partners/commissions/:id/validate     → validateCommission
 *  PATCH  /api/partners/commissions/:id/pay          → markPaid
 *  PATCH  /api/partners/commissions/:id/dispute      → disputeCommission
 *  PATCH  /api/partners/commissions/:id/cancel       → cancelCommission
 *  GET    /api/partners/commission-config            → getCommissionConfig
 *  PUT    /api/partners/commission-config            → updateCommissionConfig
 *
 * Invariants :
 * • Toute commission requiert validation humaine en P2 (zéro auto-validation).
 * • paymentChannel obligatoire au marquage 'paid'.
 * • Les partenaires (role PARTNER) voient uniquement leurs propres commissions.
 * • CommissionConfig est embarqué dans Campus model — accès via Campus.
 */

const mongoose = require('mongoose');

const PartnerCommission = require('../../models/partner-models/partner.commission.model');
const PartnerLead       = require('../../models/partner-models/partner.lead.model');
const Partner           = require('../../models/partner-models/partner.model');

const {
  asyncHandler,
  sendSuccess,
  sendError,
  sendPaginated,
  sendNotFound,
  sendForbidden,
} = require('../../utils/response-helpers');
const { isValidObjectId } = require('../../utils/validation-helpers');

// ── HELPERS ───────────────────────────────────────────────────────────────────

const isGlobalRole  = (role) => role === 'ADMIN' || role === 'DIRECTOR';
const isPartnerRole = (role) => role === 'PARTNER';

const buildCampusFilter = (req) => {
  if (isGlobalRole(req.user.role)) return {};
  if (!req.user.campusId) {
    const err = new Error('Campus information not found in your account.');
    err.statusCode = 403;
    throw err;
  }
  return { schoolCampus: new mongoose.Types.ObjectId(req.user.campusId) };
};

const PAYMENT_CHANNELS = ['momo_mtn', 'momo_orange', 'bank_transfer', 'cash', 'other'];

// ── LIST COMMISSIONS ──────────────────────────────────────────────────────────

const listCommissions = asyncHandler(async (req, res) => {
  const { status, partnerId, from, to, page = 1, limit = 20 } = req.query;

  const filter = {};

  if (isPartnerRole(req.user.role)) {
    filter.partner      = new mongoose.Types.ObjectId(req.user.id);
    filter.schoolCampus = new mongoose.Types.ObjectId(req.user.campusId);
  } else {
    const campusFilter = buildCampusFilter(req);
    Object.assign(filter, campusFilter);

    if (isGlobalRole(req.user.role) && req.query.campusId) {
      if (!isValidObjectId(req.query.campusId)) return sendError(res, 400, 'Invalid campusId.');
      filter.schoolCampus = new mongoose.Types.ObjectId(req.query.campusId);
    }

    if (partnerId && isValidObjectId(partnerId)) {
      filter.partner = new mongoose.Types.ObjectId(partnerId);
    }
  }

  if (status) filter.status = status;

  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to)   filter.createdAt.$lte = new Date(to);
  }

  const pageNum  = Math.max(1, parseInt(page,  10) || 1);
  const limitNum = Math.max(1, Math.min(parseInt(limit, 10) || 20, 100));

  // summaryFilter : même scope sans filtre status pour KPIs cohérents
  const summaryFilter = { ...filter };
  delete summaryFilter.status;

  const [commissions, total, kpis] = await Promise.all([
    PartnerCommission.find(filter)
      .populate('partner', 'firstName lastName partnerCode')
      .populate('lead',    'firstName lastName email')
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean(),
    PartnerCommission.countDocuments(filter),
    PartnerCommission.aggregate([
      { $match: summaryFilter },
      { $group: {
          _id:      '$status',
          count:    { $sum: 1 },
          totalAmt: { $sum: '$amount' },
      }},
    ]),
  ]);

  const summary = Object.fromEntries(
    kpis.map((k) => [k._id, { count: k.count, totalAmount: k.totalAmt }])
  );

  return sendPaginated(res, 200, 'Commissions retrieved.', commissions, {
    total, page: pageNum, limit: limitNum, summary,
  });
});

// ── VALIDATE COMMISSION ───────────────────────────────────────────────────────

const validateCommission = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid commission ID.');

  const campusFilter = buildCampusFilter(req);
  const commission = await PartnerCommission.findOne({
    _id: new mongoose.Types.ObjectId(id),
    ...campusFilter,
  });

  if (!commission) return sendNotFound(res, 'Commission');

  if (commission.status !== 'pending') {
    return sendError(res, 400, `Cannot validate a commission with status '${commission.status}'.`);
  }

  commission.status      = 'validated';
  commission.validatedBy = req.user.id;
  commission.validatedAt = new Date();

  await commission.save();

  // TODO P2: Notifier partenaire (WhatsApp + in-app) — commission validée

  return sendSuccess(res, 200, 'Commission validated.', commission);
});

// ── MARK PAID ─────────────────────────────────────────────────────────────────

const markPaid = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { paymentChannel, paymentRef, paidAt } = req.body;

  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid commission ID.');

  if (!paymentChannel) return sendError(res, 400, 'paymentChannel is required.');
  if (!PAYMENT_CHANNELS.includes(paymentChannel)) {
    return sendError(res, 400, `paymentChannel must be one of: ${PAYMENT_CHANNELS.join(', ')}.`);
  }
  if (paymentChannel !== 'cash' && !paymentRef?.trim()) {
    return sendError(res, 400, 'paymentRef is required for non-cash payments.');
  }

  const campusFilter = buildCampusFilter(req);
  const commission = await PartnerCommission.findOne({
    _id: new mongoose.Types.ObjectId(id),
    ...campusFilter,
  });

  if (!commission) return sendNotFound(res, 'Commission');

  if (commission.status !== 'validated') {
    return sendError(res, 400, `Cannot mark as paid: commission must be validated first (current status: '${commission.status}').`);
  }

  commission.status         = 'paid';
  commission.paymentChannel = paymentChannel;
  commission.paymentRef     = paymentRef?.trim() || null;
  commission.paidAt         = paidAt ? new Date(paidAt) : new Date();
  commission.paidBy         = req.user.id;

  await commission.save();

  // TODO P2: Notifier partenaire (WhatsApp + in-app + générer PDF reçu via puppeteer-core)

  return sendSuccess(res, 200, 'Commission marked as paid.', commission);
});

// ── DISPUTE COMMISSION ────────────────────────────────────────────────────────

const disputeCommission = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid commission ID.');

  const campusFilter = buildCampusFilter(req);
  const commission = await PartnerCommission.findOne({
    _id: new mongoose.Types.ObjectId(id),
    ...campusFilter,
  });

  if (!commission) return sendNotFound(res, 'Commission');

  if (commission.status === 'paid') {
    return sendForbidden(res, 'Cannot dispute a paid commission.');
  }

  if (!commission.fraudFlags.includes('MANUAL_REVIEW')) {
    commission.fraudFlags.push('MANUAL_REVIEW');
  }
  commission.status = 'disputed';
  if (reason?.trim()) {
    commission.notes = (commission.notes ? commission.notes + '\n' : '') + `[DISPUTE] ${reason.trim()}`;
  }

  await commission.save();

  return sendSuccess(res, 200, 'Commission flagged for dispute.', commission);
});

// ── CANCEL COMMISSION ─────────────────────────────────────────────────────────

const cancelCommission = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { cancellationReason } = req.body;

  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid commission ID.');
  if (!cancellationReason?.trim()) return sendError(res, 400, 'cancellationReason is required.');

  const campusFilter = buildCampusFilter(req);
  const commission = await PartnerCommission.findOne({
    _id: new mongoose.Types.ObjectId(id),
    ...campusFilter,
  });

  if (!commission) return sendNotFound(res, 'Commission');

  if (commission.status === 'paid') {
    return sendForbidden(res, 'Cannot cancel a paid commission.');
  }

  commission.status             = 'cancelled';
  commission.cancelledBy        = req.user.id;
  commission.cancelledAt        = new Date();
  commission.cancellationReason = cancellationReason.trim();

  await commission.save();

  return sendSuccess(res, 200, 'Commission cancelled.', commission);
});

// ── EXPORT COMMISSIONS ────────────────────────────────────────────────────────

const exportCommissions = asyncHandler(async (req, res) => {
  const campusFilter = buildCampusFilter(req);
  const { status, partnerId, format = 'csv' } = req.query;

  const filter = { ...campusFilter };
  if (status    && status !== 'all') filter.status  = status;
  if (partnerId && isValidObjectId(partnerId)) filter.partner = new mongoose.Types.ObjectId(partnerId);

  const commissions = await PartnerCommission.find(filter)
    .populate('partner', 'firstName lastName partnerCode')
    .populate('lead',    'firstName lastName email')
    .sort({ createdAt: -1 })
    .lean();

  const rows = commissions.map((c) => ({
    'Partner':         c.partner ? `${c.partner.firstName} ${c.partner.lastName}` : '',
    'Partner Code':    c.partner?.partnerCode || '',
    'Prospect':        c.lead ? `${c.lead.firstName} ${c.lead.lastName}` : '',
    'Prospect Email':  c.lead?.email || '',
    'Amount':          c.amount,
    'Currency':        c.currency,
    'Rule Type':       c.ruleSnapshot?.ruleType || '',
    'Status':          c.status,
    'Payment Channel': c.paymentChannel || '',
    'Payment Ref':     c.paymentRef || '',
    'Paid At':         c.paidAt ? new Date(c.paidAt).toISOString().slice(0, 10) : '',
    'Created At':      c.createdAt ? new Date(c.createdAt).toISOString().slice(0, 10) : '',
  }));

  if (format === 'csv') {
    const headers = Object.keys(rows[0] || {});
    const csv = [
      headers.join(','),
      ...rows.map((r) => headers.map((h) => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(',')),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="commissions_export.csv"');
    return res.end(csv);
  }

  return sendSuccess(res, 200, 'Export data retrieved.', rows);
});

// ── COMMISSION CONFIG (campus level) ─────────────────────────────────────────

const getCommissionConfig = asyncHandler(async (req, res) => {
  const campusFilter = buildCampusFilter(req);
  const campusId = campusFilter.schoolCampus || (
    req.query.campusId ? new mongoose.Types.ObjectId(req.query.campusId) : null
  );

  if (!campusId) return sendError(res, 400, 'campusId is required for ADMIN/DIRECTOR.');

  const Campus = mongoose.model('Campus');
  const campus = await Campus.findById(campusId)
    .select('commissionConfig campus_name')
    .lean();

  if (!campus) return sendNotFound(res, 'Campus');

  return sendSuccess(res, 200, 'Commission config retrieved.', {
    campusId,
    campusName:       campus.campus_name,
    commissionConfig: campus.commissionConfig || null,
  });
});

const updateCommissionConfig = asyncHandler(async (req, res) => {
  const { ruleType, fixedAmount, percentage, defaultCurrency } = req.body;

  if (!ruleType) return sendError(res, 400, 'ruleType is required.');
  if (!['FIXED', 'PERCENTAGE'].includes(ruleType)) {
    return sendError(res, 400, "ruleType must be 'FIXED' or 'PERCENTAGE'.");
  }
  if (ruleType === 'FIXED'      && fixedAmount == null) return sendError(res, 400, 'fixedAmount is required for FIXED rule.');
  if (ruleType === 'PERCENTAGE' && percentage == null)  return sendError(res, 400, 'percentage is required for PERCENTAGE rule.');

  const campusFilter = buildCampusFilter(req);
  const campusId = campusFilter.schoolCampus || (
    req.body.campusId ? new mongoose.Types.ObjectId(req.body.campusId) : null
  );

  if (!campusId) return sendError(res, 400, 'campusId is required for ADMIN/DIRECTOR.');

  const Campus = mongoose.model('Campus');
  const campus = await Campus.findByIdAndUpdate(
    campusId,
    {
      $set: {
        'commissionConfig.ruleType':        ruleType,
        'commissionConfig.fixedAmount':     fixedAmount || null,
        'commissionConfig.percentage':      percentage  || null,
        'commissionConfig.defaultCurrency': defaultCurrency || 'XAF',
        'commissionConfig.updatedBy':       req.user.id,
        'commissionConfig.updatedAt':       new Date(),
      },
    },
    { new: true, runValidators: true }
  ).select('commissionConfig campus_name').lean();

  if (!campus) return sendNotFound(res, 'Campus');

  return sendSuccess(res, 200, 'Commission config updated.', campus.commissionConfig);
});

// ── PARTNER PORTAL : OWN DASHBOARD ───────────────────────────────────────────

const getPartnerDashboard = asyncHandler(async (req, res) => {
  const partnerId  = new mongoose.Types.ObjectId(req.user.id);
  const campusId   = new mongoose.Types.ObjectId(req.user.campusId);

  const [leadStats, commissionStats, recentLeads, recentCommissions] = await Promise.all([
    PartnerLead.aggregate([
      { $match: { partner: partnerId, schoolCampus: campusId, honeypotTripped: false } },
      { $group: {
          _id:      null,
          total:    { $sum: 1 },
          enrolled: { $sum: { $cond: [{ $eq: ['$status', 'enrolled'] }, 1, 0] } },
      }},
    ]),
    PartnerCommission.aggregate([
      { $match: { partner: partnerId, schoolCampus: campusId } },
      { $group: {
          _id:      '$status',
          count:    { $sum: 1 },
          totalAmt: { $sum: '$amount' },
      }},
    ]),
    PartnerLead.find({ partner: partnerId, schoolCampus: campusId, honeypotTripped: false })
      .select('firstName lastName source status createdAt')
      .sort({ createdAt: -1 })
      .limit(5)
      .lean(),
    PartnerCommission.find({ partner: partnerId, schoolCampus: campusId })
      .select('amount currency status paymentChannel createdAt')
      .sort({ createdAt: -1 })
      .limit(3)
      .lean(),
  ]);

  const leads = leadStats[0] || { total: 0, enrolled: 0 };
  const commByStatus = Object.fromEntries(
    commissionStats.map((c) => [c._id, { count: c.count, totalAmount: c.totalAmt }])
  );

  return sendSuccess(res, 200, 'Dashboard data retrieved.', {
    kpis: {
      totalLeads:          leads.total,
      convertedLeads:      leads.enrolled,
      conversionRate:      leads.total > 0 ? Math.round((leads.enrolled / leads.total) * 100) : 0,
      pendingCommissions:  commByStatus.pending?.totalAmount    || 0,
      validatedCommissions: commByStatus.validated?.totalAmount || 0,
      paidCommissions:     commByStatus.paid?.totalAmount       || 0,
    },
    recentLeads,
    recentCommissions,
  });
});

// ── PARTNER PORTAL : PDF RECEIPT ──────────────────────────────────────────────

const downloadReceipt = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid commission ID.');

  const commission = await PartnerCommission.findOne({
    _id:         new mongoose.Types.ObjectId(id),
    partner:     new mongoose.Types.ObjectId(req.user.id),
    schoolCampus: new mongoose.Types.ObjectId(req.user.campusId),
    status:      'paid',
  }).populate('partner', 'firstName lastName partnerCode')
    .populate('lead',    'firstName lastName email')
    .lean();

  if (!commission) return sendNotFound(res, 'Commission receipt');

  // TODO P2: Générer PDF reçu via puppeteer-core (même pattern que academic-pdf.service.js)
  return sendError(res, 501, 'PDF receipt generation not yet implemented in this build.');
});

// ── EXPORTS ───────────────────────────────────────────────────────────────────

module.exports = {
  listCommissions,
  validateCommission,
  markPaid,
  disputeCommission,
  cancelCommission,
  exportCommissions,
  getCommissionConfig,
  updateCommissionConfig,
  getPartnerDashboard,
  downloadReceipt,
};
