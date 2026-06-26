'use strict';

/**
 * @file partner.commission.controller.js
 * @description Partner commission management.
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
 * Invariants:
 * • Every commission requires explicit human validation in P2 (zero auto-validation).
 * • paymentChannel is mandatory when marking as 'paid'.
 * • Partners (role PARTNER) can only see their own commissions.
 * • CommissionConfig is embedded in the Campus model — accessed via Campus.
 */

const mongoose = require('mongoose');

const partnerRepo = require('../partner.repository');
// Lazy require toward the campus facade (hub): the commission config is
// embedded in the Campus model — see campus.repository.
const campusService = () => require('../../campus').service;

const {
  asyncHandler,
  sendSuccess,
  sendError,
  sendPaginated,
  sendNotFound,
  sendForbidden,
} = require('../../../shared/utils/response-helpers');
const { isValidObjectId } = require('../../../shared/utils/validation-helpers');

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

/**
 * Builds a CSV cell, neutralizing spreadsheet formula injection (OWASP).
 * A leading =, +, -, @, tab or CR is prefixed with a single quote.
 */
const csvCell = (value) => {
  const s = String(value ?? '');
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

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

  // summaryFilter: same scope without status filter for consistent KPIs
  const summaryFilter = { ...filter };
  delete summaryFilter.status;

  const [{ data: commissions, total }, kpis] = await Promise.all([
    partnerRepo.paginateCommissions(filter, { skip: (pageNum - 1) * limitNum, limit: limitNum }),
    partnerRepo.aggregateCommissionStatusStats(summaryFilter),
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
  const commission = await partnerRepo.findCommissionScoped(new mongoose.Types.ObjectId(id), campusFilter);

  if (!commission) return sendNotFound(res, 'Commission');

  if (commission.status !== 'pending') {
    return sendError(res, 400, `Cannot validate a commission with status '${commission.status}'.`);
  }

  const updated = await partnerRepo.updateCommissionScoped(new mongoose.Types.ObjectId(id), campusFilter, {
    status:      'validated',
    validatedBy: req.user.id,
    validatedAt: new Date(),
  });

  // TODO P2: Notify partner (WhatsApp + in-app) — commission validated

  return sendSuccess(res, 200, 'Commission validated.', updated);
});

// ── MARK PAID ─────────────────────────────────────────────────────────────────

const markPaid = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { paymentChannel, paymentRef, paidAt, notes } = req.body;

  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid commission ID.');

  if (!paymentChannel) return sendError(res, 400, 'paymentChannel is required.');
  if (!PAYMENT_CHANNELS.includes(paymentChannel)) {
    return sendError(res, 400, `paymentChannel must be one of: ${PAYMENT_CHANNELS.join(', ')}.`);
  }
  if (paymentChannel !== 'cash' && !paymentRef?.trim()) {
    return sendError(res, 400, 'paymentRef is required for non-cash payments.');
  }

  const campusFilter = buildCampusFilter(req);
  const commission = await partnerRepo.findCommissionScoped(new mongoose.Types.ObjectId(id), campusFilter);

  if (!commission) return sendNotFound(res, 'Commission');

  if (commission.status !== 'validated') {
    return sendError(res, 400, `Cannot mark as paid: commission must be validated first (current status: '${commission.status}').`);
  }

  const set = {
    status:         'paid',
    paymentChannel,
    paymentRef:     paymentRef?.trim() || null,
    paidAt:         paidAt ? new Date(paidAt) : new Date(),
    paidBy:         req.user.id,
  };
  if (notes?.trim()) {
    set.notes = (commission.notes ? commission.notes + '\n' : '') + `[PAYMENT] ${notes.trim()}`;
  }

  const updated = await partnerRepo.updateCommissionScoped(new mongoose.Types.ObjectId(id), campusFilter, set);

  // TODO P2: Notify partner (WhatsApp + in-app + generate PDF receipt via puppeteer-core)

  return sendSuccess(res, 200, 'Commission marked as paid.', updated);
});

// ── DISPUTE COMMISSION ────────────────────────────────────────────────────────

const disputeCommission = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid commission ID.');

  const campusFilter = buildCampusFilter(req);
  const commission = await partnerRepo.findCommissionScoped(new mongoose.Types.ObjectId(id), campusFilter);

  if (!commission) return sendNotFound(res, 'Commission');

  if (commission.status === 'paid') {
    return sendForbidden(res, 'Cannot dispute a paid commission.');
  }

  const fraudFlags = (commission.fraudFlags || []).includes('MANUAL_REVIEW')
    ? commission.fraudFlags
    : [...(commission.fraudFlags || []), 'MANUAL_REVIEW'];

  const set = { status: 'disputed', fraudFlags };
  if (reason?.trim()) {
    set.notes = (commission.notes ? commission.notes + '\n' : '') + `[DISPUTE] ${reason.trim()}`;
  }

  const updated = await partnerRepo.updateCommissionScoped(new mongoose.Types.ObjectId(id), campusFilter, set);

  return sendSuccess(res, 200, 'Commission flagged for dispute.', updated);
});

// ── CANCEL COMMISSION ─────────────────────────────────────────────────────────

const cancelCommission = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { cancellationReason } = req.body;

  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid commission ID.');
  if (!cancellationReason?.trim()) return sendError(res, 400, 'cancellationReason is required.');

  const campusFilter = buildCampusFilter(req);
  const commission = await partnerRepo.findCommissionScoped(new mongoose.Types.ObjectId(id), campusFilter);

  if (!commission) return sendNotFound(res, 'Commission');

  if (commission.status === 'paid') {
    return sendForbidden(res, 'Cannot cancel a paid commission.');
  }

  const updated = await partnerRepo.updateCommissionScoped(new mongoose.Types.ObjectId(id), campusFilter, {
    status:             'cancelled',
    cancelledBy:        req.user.id,
    cancelledAt:        new Date(),
    cancellationReason: cancellationReason.trim(),
  });

  return sendSuccess(res, 200, 'Commission cancelled.', updated);
});

// ── EXPORT COMMISSIONS ────────────────────────────────────────────────────────

const exportCommissions = asyncHandler(async (req, res) => {
  const campusFilter = buildCampusFilter(req);
  const { status, partnerId, format = 'csv' } = req.query;

  const filter = { ...campusFilter };
  if (status    && status !== 'all') filter.status  = status;
  if (partnerId && isValidObjectId(partnerId)) filter.partner = new mongoose.Types.ObjectId(partnerId);

  const commissions = await partnerRepo.listCommissionsForExport(filter);

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
      ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(',')),
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

  const campus = await campusService().getCampusCommissionConfigWithName(campusId);

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

  const campus = await campusService().setCampusCommissionConfig(campusId, {
    ruleType,
    fixedAmount:     fixedAmount || null,
    percentage:      percentage  || null,
    defaultCurrency: defaultCurrency || 'XAF',
    updatedBy:       req.user.id,
  });

  if (!campus) return sendNotFound(res, 'Campus');

  return sendSuccess(res, 200, 'Commission config updated.', campus.commissionConfig);
});

// ── PARTNER PORTAL : OWN DASHBOARD ───────────────────────────────────────────

const getPartnerDashboard = asyncHandler(async (req, res) => {
  const partnerId  = new mongoose.Types.ObjectId(req.user.id);
  const campusId   = new mongoose.Types.ObjectId(req.user.campusId);

  const leadMatch = { partner: partnerId, schoolCampus: campusId, honeypotTripped: false };

  const [leadStats, sourceStats, commissionStats, recentLeads, recentCommissions] = await Promise.all([
    partnerRepo.aggregateLeadConversionStats(leadMatch),
    partnerRepo.aggregateLeadSourceStats(leadMatch),
    partnerRepo.aggregateCommissionStatusStats({ partner: partnerId, schoolCampus: campusId }),
    partnerRepo.listRecentLeadsForPartner({ partnerId, campusId, limit: 5 }),
    partnerRepo.listRecentCommissionsForPartner({ partnerId, campusId, limit: 3 }),
  ]);

  const leads = leadStats[0] || { total: 0, enrolled: 0 };
  const commByStatus = Object.fromEntries(
    commissionStats.map((c) => [c._id, { count: c.count, totalAmount: c.totalAmt }])
  );

  // Lead totals by attribution source (QR vs link vs manual vs direct) — drives
  // the partner's referral-performance breakdown. Null `_id` (legacy/unknown) is
  // folded into 'direct' so the shape stays stable for the UI.
  const sourceBreakdown = sourceStats.map((s) => ({
    source:   s._id || 'direct',
    total:    s.total,
    enrolled: s.enrolled,
  }));

  return sendSuccess(res, 200, 'Dashboard data retrieved.', {
    kpis: {
      totalLeads:          leads.total,
      convertedLeads:      leads.enrolled,
      conversionRate:      leads.total > 0 ? Math.round((leads.enrolled / leads.total) * 100) : 0,
      pendingCommissions:  commByStatus.pending?.totalAmount    || 0,
      validatedCommissions: commByStatus.validated?.totalAmount || 0,
      paidCommissions:     commByStatus.paid?.totalAmount       || 0,
    },
    sourceBreakdown,
    recentLeads,
    recentCommissions,
  });
});

// ── PARTNER PORTAL : PDF RECEIPT ──────────────────────────────────────────────

const downloadReceipt = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid commission ID.');

  const commission = await partnerRepo.findPaidCommissionReceipt({
    id:        new mongoose.Types.ObjectId(id),
    partnerId: new mongoose.Types.ObjectId(req.user.id),
    campusId:  new mongoose.Types.ObjectId(req.user.campusId),
  });

  if (!commission) return sendNotFound(res, 'Commission receipt');

  const campus = await campusService().getCampusName(req.user.campusId).catch(() => null);
  const pdfBuffer = await require('../partner.pdf.service').generateCommissionReceiptPdf(
    commission,
    { campusName: campus?.campus_name },
  );

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="receipt_${commission._id}.pdf"`);
  return res.end(pdfBuffer);
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
