'use strict';

/**
 * @file partner.lead.controller.js
 * @description Gestion du pipeline de leads et pré-inscription publique.
 *
 * Routes:
 *  POST   /api/partners/public/pre-register         → publicPreRegister  (PUBLIC, rate-limited)
 *  GET    /api/partners/public/resolve/:code         → resolveCode        (PUBLIC)
 *  GET    /api/partners/leads                        → listLeads          (MGR/DIR/ADMIN/PARTNER)
 *  GET    /api/partners/leads/export                 → exportLeads        (MGR/DIR/ADMIN)
 *  GET    /api/partners/leads/:id                    → getLead            (MGR/DIR/ADMIN/PARTNER)
 *  PATCH  /api/partners/leads/:id/status             → updateLeadStatus   (MGR/DIR/ADMIN)
 *  DELETE /api/partners/leads/:id                    → deleteLead         (MGR/DIR/ADMIN)
 *
 * Anti-fraude (publicPreRegister) :
 *  1. HONEYPOT      → silent 200, aucune écriture DB
 *  2. SELF_REFERRAL → reject 422
 *  3. DUPLICATE_LEAD (email OU phone + campus) → reject 409
 *  4. IP_BURST (>5 leads en 1h depuis même ipHash) → flagged, lead créé
 *
 * Commission engine : déclenché quand status → 'enrolled'
 * ipAddressHash : SHA-256, jamais IP brute (RGPD + Loi n°2010/012)
 */

const crypto   = require('crypto');
const mongoose = require('mongoose');

const partnerRepo = require('../partner.repository');
// Lazy require toward the campus facade (hub) — see MODULAR_MONOLITH_MIGRATION.md
const getCampusCommissionConfig = (...args) => require('../../campus').service.getCampusCommissionConfig(...args);

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

// ── HELPERS ───────────────────────────────────────────────────────────────────

const isGlobalRole   = (role) => role === 'ADMIN' || role === 'DIRECTOR';
const isManagerRole  = (role) => isGlobalRole(role) || role === 'CAMPUS_MANAGER';
const isPartnerRole  = (role) => role === 'PARTNER';

const buildCampusFilter = (req) => {
  if (isGlobalRole(req.user.role)) return {};
  if (!req.user.campusId) {
    const err = new Error('Campus information not found in your account.');
    err.statusCode = 403;
    throw err;
  }
  return { schoolCampus: new mongoose.Types.ObjectId(req.user.campusId) };
};

const hashIp = (ip) => crypto.createHash('sha256').update(ip || '').digest('hex');

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Builds a CSV cell, neutralizing spreadsheet formula injection (OWASP).
 * A leading =, +, -, @, tab or CR is prefixed with a single quote.
 */
const csvCell = (value) => {
  const s = String(value ?? '');
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

// Transitions de statut valides dans le pipeline
const VALID_TRANSITIONS = {
  new:               ['contacted', 'rejected', 'abandoned'],
  contacted:         ['dossier_submitted', 'rejected', 'abandoned'],
  dossier_submitted: ['admitted', 'rejected', 'abandoned'],
  admitted:          ['enrolled', 'rejected', 'abandoned'],
  enrolled:          [],   // statut terminal
  rejected:          [],   // statut terminal
  abandoned:         [],   // statut terminal
};

/**
 * Calcule et crée la commission lors du passage au statut 'enrolled'.
 * Lit commissionConfig du partenaire (override) ou du campus (défaut).
 */
const triggerCommissionEngine = async (lead, partner, tuitionFee = null) => {
  // Check that no commission already exists for this lead
  const existing = await partnerRepo.findCommissionByLead(lead._id);
  if (existing) return existing;

  // Commission config: partner override takes priority → campus config
  let config = partner.commissionConfig?.ruleType
    ? partner.commissionConfig
    : null;

  if (!config) {
    const campus = await getCampusCommissionConfig(lead.schoolCampus);
    if (campus?.commissionConfig?.ruleType) {
      config = campus.commissionConfig;
    }
  }

  if (!config || !config.ruleType) {
    // No config — create a commission at 0 in pending for manual review
    return partnerRepo.createCommission({
      schoolCampus:  lead.schoolCampus,
      partner:       partner._id,
      lead:          lead._id,
      amount:        0,
      currency:      'XAF',
      ruleSnapshot:  { ruleType: 'FIXED', fixedAmount: 0, currency: 'XAF' },
      status:        'pending',
      notes:         'No commission config found — amount set to 0 for manual review.',
    });
  }

  let amount = 0;
  // Partner-level override uses `currency`; campus-level config uses `defaultCurrency`.
  const currency = config.currency || config.defaultCurrency || 'XAF';

  if (config.ruleType === 'FIXED') {
    amount = config.fixedAmount || 0;
  } else if (config.ruleType === 'PERCENTAGE') {
    if (!tuitionFee || tuitionFee <= 0) {
      amount = 0;
    } else {
      amount = Math.round((config.percentage / 100) * tuitionFee);
    }
  }

  const ruleSnapshot = {
    ruleType:    config.ruleType,
    fixedAmount: config.fixedAmount || null,
    percentage:  config.percentage  || null,
    currency,
    tier:        partner.tier || null,
  };

  const commission = await partnerRepo.createCommission({
    schoolCampus: lead.schoolCampus,
    partner:      partner._id,
    lead:         lead._id,
    amount,
    currency,
    ruleSnapshot,
    status:       'pending',
    fraudFlags:   lead.fraudFlags || [],
  });

  // Lier la commission au lead
  await partnerRepo.setLeadCommission(lead._id, commission._id);

  return commission;
};

// ── PUBLIC : RESOLVE CODE ─────────────────────────────────────────────────────

/**
 * Résout un partnerCode → branding campus pour la page de pré-inscription.
 *
 * @route  GET /api/partners/public/resolve/:code
 * @access PUBLIC
 */
const resolveCode = asyncHandler(async (req, res) => {
  const { code } = req.params;
  if (!code?.trim()) return sendError(res, 400, 'Partner code is required.');

  const partner = await partnerRepo.findActivePartnerByCodeForResolve(code);

  if (!partner) return sendNotFound(res, 'Partner code');

  return sendSuccess(res, 200, 'Partner code resolved.', {
    partnerCode: partner.partnerCode,
    partnerName: `${partner.firstName} ${partner.lastName}`,
    campus:      partner.schoolCampus,
  });
});

// ── PUBLIC : PRE-REGISTER ─────────────────────────────────────────────────────

/**
 * Soumission pré-inscription prospect via lien affilié.
 * Rate-limited : 10 req/h/IP (appliqué dans le router).
 *
 * @route  POST /api/partners/public/pre-register
 * @access PUBLIC
 */
const publicPreRegister = asyncHandler(async (req, res) => {
  const {
    firstName, lastName, email, phone,
    programInterest, source,
    utm_source, utm_medium, utm_campaign,
  } = req.body;

  // Compatibility alias — the public portal sends `partnerCode` / `website`,
  // the old contract used `referralCode` / `_hp`. Both are accepted.
  const referralCode = req.body.referralCode ?? req.body.partnerCode;
  const honeypot     = req.body._hp ?? req.body.website;

  // 1. HONEYPOT — silent discard, no DB write
  if (honeypot) {
    return sendSuccess(res, 200, 'Pre-registration received.');
  }

  // Validation champs obligatoires
  if (!firstName?.trim()) return sendError(res, 400, 'firstName is required.');
  if (!lastName?.trim())  return sendError(res, 400, 'lastName is required.');
  if (!email?.trim())     return sendError(res, 400, 'email is required.');
  if (!referralCode?.trim()) return sendError(res, 400, 'referralCode is required.');

  const normalizedEmail = email.toLowerCase().trim();
  const normalizedCode  = referralCode.toUpperCase().trim();

  // Resolve the partner from the code
  const partner = await partnerRepo.findActivePartnerForPreRegister(normalizedCode);

  if (!partner) return sendError(res, 404, 'Invalid or inactive referral code.');

  const campusId = partner.schoolCampus;

  // 2. SELF_REFERRAL — the partner pre-registers themselves
  if (normalizedEmail === partner.email?.toLowerCase()) {
    return sendError(res, 422, 'Self-referral is not allowed.');
  }

  // 3. DUPLICATE_LEAD — same email OR same phone on the same campus
  const dupOr = [{ email: normalizedEmail }];
  if (phone?.trim()) dupOr.push({ phone: phone.trim() });

  const duplicate = await partnerRepo.findActiveLeadByContact({ campusId, dupOr });
  if (duplicate) {
    return sendError(res, 409, 'A registration with this email or phone already exists for this campus.');
  }

  // 4. IP_BURST — >5 leads from the same IP hash within 1 hour
  const rawIp  = req.ip || req.connection?.remoteAddress || '';
  const ipHash = hashIp(rawIp);
  const fraudFlags = [];

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const ipBurstCount = await partnerRepo.countRecentLeadsByIp({ ipAddressHash: ipHash, since: oneHourAgo });

  if (ipBurstCount >= 5) {
    fraudFlags.push('IP_BURST');
  }

  // Detect source from the request context
  const detectedSource = source || (req.query.ref ? 'referral_link' : 'manual_code');

  const lead = await partnerRepo.createLead({
    schoolCampus:    campusId,
    partner:         partner._id,
    partnerCode:     normalizedCode,
    firstName:       firstName.trim(),
    lastName:        lastName.trim(),
    email:           normalizedEmail,
    phone:           phone?.trim() || null,
    programInterest: programInterest?.trim() || null,
    source:          detectedSource,
    status:          'new',
    statusHistory:   [{ status: 'new', changedBy: null, changedAt: new Date(), note: 'Pre-registration submitted.' }],
    utmParams:       (utm_source || utm_medium || utm_campaign)
                       ? { utm_source, utm_medium, utm_campaign }
                       : null,
    ipAddressHash:   ipHash,
    honeypotTripped: false,
    fraudFlags,
  });

  // Update partner's lastActivityAt (fire-and-forget)
  partnerRepo.touchActivity(partner._id).catch(() => {});

  // TODO P2: Notifier Campus Manager (WhatsApp + in-app) — nouveau lead
  // TODO P2: Notifier Partner (in-app) — nouveau lead dans le pipeline

  return sendCreated(res, 'Pre-registration received successfully.', {
    leadId:      lead._id,
    partnerCode: normalizedCode,
    status:      lead.status,
  });
});

// ── LIST LEADS ────────────────────────────────────────────────────────────────

const listLeads = asyncHandler(async (req, res) => {
  const { status, partnerId, source, from, to, search, page = 1, limit = 20 } = req.query;

  const filter = { honeypotTripped: false };

  if (isPartnerRole(req.user.role)) {
    // Le partenaire voit uniquement ses propres leads
    filter.partner = new mongoose.Types.ObjectId(req.user.id);
    filter.schoolCampus = new mongoose.Types.ObjectId(req.user.campusId);
  } else {
    // Campus isolation
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

  if (status)  filter.status = status;
  if (source)  filter.source = source;

  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to)   filter.createdAt.$lte = new Date(to);
  }

  if (search) {
    const re = { $regex: escapeRegex(search), $options: 'i' };
    filter.$or = [
      { firstName: re },
      { lastName:  re },
      { email:     re },
    ];
  }

  const pageNum  = Math.max(1, parseInt(page,  10) || 1);
  const limitNum = Math.max(1, Math.min(parseInt(limit, 10) || 20, 100));

  // summaryFilter: same scope without the status filter so KPIs stay stable
  // across status views (mirrors the commission list pattern).
  const summaryFilter = { ...filter };
  delete summaryFilter.status;

  const [{ data: leads, total }, statusStats] = await Promise.all([
    partnerRepo.paginateLeads(filter, { skip: (pageNum - 1) * limitNum, limit: limitNum }),
    partnerRepo.aggregateLeadStatusStats(summaryFilter),
  ]);

  const summary = Object.fromEntries(statusStats.map((s) => [s._id, s.count]));

  return sendPaginated(res, 200, 'Leads retrieved.', leads, { total, page: pageNum, limit: limitNum, summary });
});

// ── GET ONE LEAD ──────────────────────────────────────────────────────────────

const getLead = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid lead ID.');

  const filter = { _id: new mongoose.Types.ObjectId(id), honeypotTripped: false };

  if (isPartnerRole(req.user.role)) {
    filter.partner      = new mongoose.Types.ObjectId(req.user.id);
    filter.schoolCampus = new mongoose.Types.ObjectId(req.user.campusId);
  } else {
    const campusFilter = buildCampusFilter(req);
    Object.assign(filter, campusFilter);
  }

  const lead = await partnerRepo.findLeadScoped(filter);

  if (!lead) return sendNotFound(res, 'Lead');

  return sendSuccess(res, 200, 'Lead retrieved.', lead);
});

// ── UPDATE LEAD STATUS ────────────────────────────────────────────────────────

const updateLeadStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status: newStatus, note, tuitionFee } = req.body;

  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid lead ID.');
  if (!newStatus)           return sendError(res, 400, 'status is required.');

  const campusFilter = buildCampusFilter(req);
  const leadId = new mongoose.Types.ObjectId(id);
  const lead = await partnerRepo.findLeadForWrite(leadId, campusFilter);

  if (!lead) return sendNotFound(res, 'Lead');

  const currentStatus = lead.status;

  // Verify valid transition
  const allowed = VALID_TRANSITIONS[currentStatus];
  if (!allowed) return sendError(res, 400, `Status '${currentStatus}' is terminal.`);
  if (!allowed.includes(newStatus)) {
    return sendError(res, 400, `Invalid transition: '${currentStatus}' → '${newStatus}'. Allowed: [${allowed.join(', ')}].`);
  }

  // Status update + history recording
  const updatedLead = await partnerRepo.applyLeadStatus(leadId, campusFilter, newStatus, {
    status:    newStatus,
    changedBy: req.user.id,
    changedAt: new Date(),
    note:      note?.trim() || null,
  });

  // If enrolled → trigger the commission engine
  let commission = null;
  if (newStatus === 'enrolled') {
    const partner = await partnerRepo.findPartnerForCommission(updatedLead.partner);
    if (partner) {
      commission = await triggerCommissionEngine(updatedLead, partner, tuitionFee || null);
    }
    // TODO P2: Notifier Partner (WhatsApp + in-app) — lead converti, commission pending
  } else {
    // TODO P2: Notify Partner (WhatsApp + in-app) — status advanced
  }

  return sendSuccess(res, 200, `Lead status updated to '${newStatus}'.`, {
    lead: updatedLead,
    ...(commission && { commission }),
  });
});

// ── DELETE LEAD (soft delete → abandoned) ────────────────────────────────────

const deleteLead = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid lead ID.');

  const campusFilter = buildCampusFilter(req);
  const lead = await partnerRepo.findLeadForWrite(new mongoose.Types.ObjectId(id), campusFilter);

  if (!lead) return sendNotFound(res, 'Lead');

  // Blocked if a commission is linked
  if (lead.commissionId) {
    return sendForbidden(res, 'Cannot delete a lead with an associated commission.');
  }

  await partnerRepo.softAbandonLead(lead._id, {
    status:    'abandoned',
    changedBy: req.user.id,
    changedAt: new Date(),
    note:      'Soft-deleted by manager.',
  });

  return sendSuccess(res, 200, 'Lead marked as abandoned.');
});

// ── EXPORT LEADS ──────────────────────────────────────────────────────────────

const exportLeads = asyncHandler(async (req, res) => {
  const campusFilter = buildCampusFilter(req);
  const { status, partnerId, format = 'csv' } = req.query;

  const filter = { honeypotTripped: false, ...campusFilter };
  if (status    && status !== 'all') filter.status  = status;
  if (partnerId && isValidObjectId(partnerId)) filter.partner = new mongoose.Types.ObjectId(partnerId);

  const leads = await partnerRepo.listLeadsForExport(filter);

  const rows = leads.map((l) => ({
    'First Name':     l.firstName,
    'Last Name':      l.lastName,
    'Email':          l.email,
    'Phone':          l.phone || '',
    'Program':        l.programInterest || '',
    'Source':         l.source,
    'Status':         l.status,
    'Partner Code':   l.partnerCode,
    'Partner Name':   l.partner ? `${l.partner.firstName} ${l.partner.lastName}` : '',
    'Created At':     l.createdAt ? new Date(l.createdAt).toISOString().slice(0, 10) : '',
  }));

  if (format === 'csv') {
    const headers = Object.keys(rows[0] || {});
    const csv = [
      headers.join(','),
      ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(',')),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leads_export.csv"');
    return res.end(csv);
  }

  return sendSuccess(res, 200, 'Export data retrieved.', rows);
});

// ── EXPORTS ───────────────────────────────────────────────────────────────────

module.exports = {
  resolveCode,
  publicPreRegister,
  listLeads,
  getLead,
  updateLeadStatus,
  deleteLead,
  exportLeads,
};
