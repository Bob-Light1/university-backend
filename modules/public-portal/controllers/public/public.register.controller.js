'use strict';

/**
 * @file public.register.controller.js
 * @description Pré-inscription publique via portail partenaire.
 *
 * Route : POST /api/public/pre-register
 *
 * Gère deux cas :
 *  - Avec partnerCode  : lead attribué au partenaire (referral_link | qr_code | manual_code)
 *  - Sans partnerCode  : lead direct — campus résolu via campusSlug
 *
 * Anti-fraude :
 *  1. HONEYPOT      → silent 200, aucune écriture DB
 *  2. SELF_REFERRAL → 422 (partenaire se pré-inscrit avec son propre code)
 *  3. DÉDUPLICATION (même email ou téléphone sur le même campus) → mise à jour
 *     silencieuse du lead existant (spec §4.1 / §9.2), attribution first-touch.
 *  4. IP_BURST (>5 leads de même IP hash en <10 min) → lead créé, flag ajouté
 *
 * Payload attendu (spec §3.3) :
 *  firstName, lastName, email (required)
 *  phone, programInterest, partnerCode, campusSlug (optional)
 *  source: 'referral_link' | 'qr_code' | 'manual_code' | 'direct'
 *  utmParams: { utm_source, utm_medium, utm_campaign }
 *  honeypot: '' (doit être vide)
 */

const partnerService = require('../../../partner').service; // façade module partner (§3)
const Campus         = require('../../../../models/campus.model');

const {
  asyncHandler,
  sendSuccess,
  sendCreated,
  sendError,
  sendNotFound,
} = require('../../../../shared/utils/response-helpers');

// Même règle de validation que le modèle Partner — cohérence ERP.
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

  // Validation champs obligatoires
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
    // ── Flux partenaire ──────────────────────────────────────────────────
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
    // ── Flux direct — résolution via campusSlug ─────────────────────────
    if (!campusSlug?.trim()) {
      return sendError(res, 400, 'campusSlug is required for direct registrations.');
    }

    const campus = await Campus.findOne({
      campusSlug: campusSlug.toLowerCase().trim(),
      status:     'active',
    }).select('_id').lean();

    if (!campus) {
      return sendNotFound(res, 'Campus');
    }

    campusId = campus._id;
  }

  const normalizedPhone = phone?.trim() || null;
  const detectedSource  = source || (resolvedCode ? 'referral_link' : 'direct');

  // 3 + 4. DÉDUPLICATION silencieuse (first-touch) puis création avec
  // détection IP_BURST — logique métier portée par le module partner.
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
