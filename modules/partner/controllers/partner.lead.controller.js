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
const QRCode   = require('qrcode');

const partnerRepo = require('../partner.repository');
const partnerService = require('../partner.service');
const { buildReferralUrl } = require('../../../shared/utils/referral');
const {
  asyncHandler,
  sendSuccess,
  sendError,
  sendCreated,
  sendPaginated,
  sendNotFound,
} = require('../../../shared/utils/response-helpers');
const { isValidObjectId, buildCampusFilter: deriveCampusFilter } = require('../../../shared/utils/validation-helpers');
const { admissionHandler } = require('../../../shared/utils/admission-response');
const admission = require('../admission.service');
const admissionAccess = require('../admission.access.service');
const { csvField } = require('../../../shared/utils/csv');

// ── HELPERS ───────────────────────────────────────────────────────────────────

const isGlobalRole   = (role) => role === 'ADMIN' || role === 'DIRECTOR';
const isPartnerRole  = (role) => role === 'PARTNER';

const buildCampusFilter = (req) => deriveCampusFilter(req.user, req.query.campusId);

const hashIp = (ip) => crypto.createHash('sha256').update(ip || '').digest('hex');

/** Strips a phone to its digits for format-agnostic equality comparison. */
const phoneDigits = (p) => String(p || '').replace(/\D/g, '');

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── PUBLIC : RESOLVE CODE ─────────────────────────────────────────────────────

/**
 * Resolves a partnerCode → campus branding for a referral landing.
 *
 * Public and keyed by a guessable code, so it exposes only campus branding and
 * the normalized code — never the partner's identity (PII). Rate-limited in the
 * router to deter code enumeration.
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
    campus:      partner.schoolCampus,
  });
});

// ── PUBLIC : QR CODE (live) ───────────────────────────────────────────────────

/**
 * Streams the partner's referral QR code as a PNG, generated on the fly from the
 * partnerCode. The QR encodes only a public marketing URL (no secret), so the
 * route is public — which lets it be used directly as an <img> src. Nothing is
 * written to disk, so it survives redeploys and works across instances.
 *
 * @route  GET /api/partners/public/qr/:code
 * @access PUBLIC
 */
const streamReferralQr = asyncHandler(async (req, res) => {
  const { code } = req.params;
  if (!code?.trim()) return sendError(res, 400, 'Partner code is required.');

  // Validate the code maps to an active partner before spending CPU on a QR.
  const partner = await partnerRepo.findActivePartnerByCodeForResolve(code);
  if (!partner) return sendNotFound(res, 'Partner code');

  const target = buildReferralUrl(partner.partnerCode, { src: 'qr' });

  const buffer = await QRCode.toBuffer(target, {
    type:                 'png',
    width:                300,
    errorCorrectionLevel: 'M',
    margin:               2,
    color: { dark: '#000000', light: '#FFFFFF' },
  });

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.end(buffer);
});

// ── PUBLIC : REFERRAL HIT TRACKING ────────────────────────────────────────────

/**
 * Records a top-of-funnel referral hit (a `/r/{code}` scan or click) as an
 * atomic counter increment on the partner. `?src=qr` marks a scanned QR; anything
 * else counts as a shared-link click. Called server-side from the portal's
 * redirector (non-blocking), so it always answers 204 quickly and never leaks
 * whether the code exists. Rate-limited in the router to bound bot inflation.
 *
 * @route  POST /api/partners/public/track/:code
 * @access PUBLIC
 */
const trackReferralHit = asyncHandler(async (req, res) => {
  const { code } = req.params;
  if (code?.trim()) {
    const isQr = String(req.query.src || '').toLowerCase() === 'qr';
    // Fire-and-forget: analytics must never delay or fail the beacon response.
    partnerRepo.incrementReferralHit(code, isQr).catch(() => {});
  }
  return res.status(204).end();
});

// ── PUBLIC : PRE-REGISTER (DEPRECATED) ────────────────────────────────────────

/**
 * Affiliate pre-registration (legacy endpoint).
 *
 * @deprecated The canonical funnel is the public portal — POST /api/public/pre-register.
 * The ERP `/register` page now redirects there, so nothing first-party calls this
 * route anymore. It is retained only as a thin, back-compatible alias for any
 * previously printed/shared link that still posts here. It delegates persistence
 * to the SAME `partnerService.upsertPreRegistrationLead` the portal uses, so the
 * anti-fraud semantics are now identical: silent first-touch deduplication (no
 * more 409 reject) and IP_BURST detection over a 10-minute window. Synchronous
 * input validation, partner resolution and self-referral checks stay here so a
 * bad code is surfaced immediately.
 *
 * Rate-limited: 10 req/h/IP (applied in the router).
 *
 * @route  POST /api/partners/public/pre-register
 * @access PUBLIC
 */
const publicPreRegister = asyncHandler(async (req, res) => {
  const {
    firstName, lastName, email, phone,
    programInterest, source, city, country,
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

  // Required-field validation
  if (!firstName?.trim()) return sendError(res, 400, 'firstName is required.');
  if (!lastName?.trim())  return sendError(res, 400, 'lastName is required.');
  if (!email?.trim())     return sendError(res, 400, 'email is required.');
  if (!referralCode?.trim()) return sendError(res, 400, 'referralCode is required.');

  const normalizedEmail = email.toLowerCase().trim();
  const normalizedCode  = referralCode.toUpperCase().trim();

  // Resolve the partner from the code
  const partner = await partnerRepo.findActivePartnerForPreRegister(normalizedCode);

  if (!partner) return sendError(res, 404, 'Invalid or inactive referral code.');

  // 2. SELF_REFERRAL — the partner pre-registers themselves (email OR phone)
  const partnerPhone = phoneDigits(partner.phone);
  if (normalizedEmail === partner.email?.toLowerCase()
    || (partnerPhone && phoneDigits(phone) === partnerPhone)) {
    return sendError(res, 422, 'Self-referral is not allowed.');
  }

  // 3 + 4. Persistence (first-touch dedup + IP_BURST) delegated to the shared
  // service — the single source of truth also used by the public portal queue.
  const utmParams = (utm_source || utm_medium || utm_campaign)
    ? { utm_source, utm_medium, utm_campaign }
    : null;

  const { leadId, status } = await partnerService.upsertPreRegistrationLead({
    campusId:        partner.schoolCampus,
    partner:         { _id: partner._id },
    partnerCode:     normalizedCode,
    firstName:       firstName.trim(),
    lastName:        lastName.trim(),
    email:           normalizedEmail,
    phone:           phone?.trim() || null,
    programInterest: programInterest?.trim() || null,
    city:            city?.trim() || null,
    country:         country?.trim() || null,
    source:          source || 'referral_link',
    utmParams,
    ipAddressHash:   hashIp(req.ip || req.connection?.remoteAddress || ''),
    notifyNextBatch: false, sendDossierAccess: true,
  });

  return sendCreated(res, 'Pre-registration received successfully.', {
    leadId,
    partnerCode: normalizedCode,
    status,
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
    partnerRepo.paginateLeads(filter, { skip: (pageNum - 1) * limitNum, limit: limitNum, partnerView: isPartnerRole(req.user.role) }),
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

const updateLeadStatus = admissionHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid lead ID.');
  const result = await admission.transition({
    id: req.params.id, campusFilter: buildCampusFilter(req), actor: req.user,
    status: req.body.status, revision: req.body.revision, student: req.body.student,
    tuitionFee: req.body.tuitionFee, note: req.body.note,
  });
  result.delivery = await admissionAccess.flush(result.delivery);
  return sendSuccess(res, 200, 'Lead status updated.', result);
});

// ── DELETE LEAD (soft delete → abandoned) ────────────────────────────────────

const deleteLead = admissionHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid lead ID.');
  const result = await admission.transition({
    id: req.params.id, campusFilter: buildCampusFilter(req), actor: req.user,
    status: 'abandoned', revision: req.body.revision, note: 'Archived by management.',
  });
  return sendSuccess(res, 200, 'Lead marked as abandoned.', result);
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
      ...rows.map((r) => headers.map((h) => csvField(r[h])).join(',')),
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
  streamReferralQr,
  trackReferralHit,
  publicPreRegister,
  listLeads,
  getLead,
  updateLeadStatus,
  deleteLead,
  exportLeads,
};
