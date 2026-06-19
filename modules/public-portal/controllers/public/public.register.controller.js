'use strict';

/**
 * @file public.register.controller.js
 * @description Public pre-registration via partner portal.
 *
 * Route: POST /api/public/pre-register
 *
 * Handles two cases:
 *  - With partnerCode  : lead attributed to the partner (referral_link | qr_code | manual_code)
 *  - Without partnerCode : direct lead — campus resolved via campusSlug
 *
 * Anti-fraud:
 *  1. HONEYPOT      → silent 200, no DB write
 *  2. SELF_REFERRAL → 422 (partner pre-registers with their own code)
 *  3. DEDUPLICATION (same email or phone on the same campus) → silent
 *     update of the existing lead (spec §4.1 / §9.2), first-touch attribution.
 *  4. IP_BURST (>5 leads from the same IP hash in <10 min) → lead created, flag added
 *
 * Expected payload (spec §3.3):
 *  firstName, lastName, email (required)
 *  phone, programInterest, partnerCode, campusSlug (optional)
 *  source: 'referral_link' | 'qr_code' | 'manual_code' | 'direct'
 *  utmParams: { utm_source, utm_medium, utm_campaign }
 *  honeypot: '' (must be empty)
 */

const partnerService = require('../../../partner').service; // partner module facade (§3)
// Lazy require to the campus facade (hub) — see MODULAR_MONOLITH_MIGRATION.md
const campusSvc = () => require('../../../campus').service;

const {
  asyncHandler,
  sendSuccess,
  sendCreated,
  sendError,
  sendNotFound,
} = require('../../../../shared/utils/response-helpers');

// Same validation rule as the Partner model — ERP consistency.
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

const publicPreRegister = asyncHandler(async (req, res) => {
  const {
    firstName, lastName, email, phone,
    programInterest, partnerCode, campusSlug,
    source, utmParams, honeypot,
    country, city,
    notifyNextBatch,
  } = req.body;

  // 1. HONEYPOT — silent discard
  if (honeypot) {
    return sendSuccess(res, 200, 'Pre-registration received.');
  }

  // Required field validation
  if (!firstName?.trim()) return sendError(res, 400, 'firstName is required.');
  if (!lastName?.trim())  return sendError(res, 400, 'lastName is required.');
  if (!email?.trim())     return sendError(res, 400, 'email is required.');

  const normalizedEmail = email.toLowerCase().trim();

  if (!EMAIL_REGEX.test(normalizedEmail)) {
    return sendError(res, 400, 'A valid email address is required.');
  }

  let partner   = null;
  let campusId  = null;
  let resolvedCode = null;

  if (partnerCode?.trim()) {
    // ── Partner flow ─────────────────────────────────────────────────────
    partner = await partnerService.findActivePartnerByCode(partnerCode);

    if (!partner) {
      return sendError(res, 404, 'Invalid or inactive referral code.');
    }

    campusId     = partner.schoolCampus;
    resolvedCode = partner.partnerCode;

    // 2. SELF_REFERRAL
    if (normalizedEmail === partner.email?.toLowerCase()) {
      return sendError(res, 422, 'Self-referral is not allowed.');
    }
  } else {
    // ── Direct flow — resolution via campusSlug ─────────────────────────
    if (!campusSlug?.trim()) {
      return sendError(res, 400, 'campusSlug is required for direct registrations.');
    }

    const campus = await campusSvc().getActiveCampusBySlug(campusSlug.toLowerCase().trim(), '_id');

    if (!campus) {
      return sendNotFound(res, 'Campus');
    }

    campusId = campus._id;
  }

  const normalizedPhone = phone?.trim() || null;
  const detectedSource  = source || (resolvedCode ? 'referral_link' : 'direct');

  // 3 + 4. Silent DEDUPLICATION (first-touch) then creation with
  // IP_BURST detection — business logic carried by the partner module.
  const { leadId, status, created } = await partnerService.upsertPreRegistrationLead({
    campusId,
    partner,
    partnerCode:     resolvedCode,
    firstName:       firstName.trim(),
    lastName:        lastName.trim(),
    email:           normalizedEmail,
    phone:           normalizedPhone,
    programInterest: programInterest?.trim() || null,
    city:            city?.trim() || null,
    country:         country?.trim() || null,
    source:          detectedSource,
    utmParams:       utmParams || null,
    ipAddressHash:   req.ipHash,
    notifyNextBatch: !!notifyNextBatch,
  });

  if (!created) {
    return sendSuccess(res, 200, 'Pre-registration received successfully.', { leadId, status });
  }
  return sendCreated(res, 'Pre-registration received successfully.', { leadId, status });
});

module.exports = { publicPreRegister };
