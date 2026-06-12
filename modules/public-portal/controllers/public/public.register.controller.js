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

const Partner     = require('../../../../models/partner-models/partner.model');
const PartnerLead = require('../../../../models/partner-models/partner.lead.model');
const Campus      = require('../../../../models/campus.model');

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
    const normalizedCode = partnerCode.toUpperCase().trim();

    partner = await Partner.findOne({
      partnerCode: normalizedCode,
      status:      'active',
    }).select('_id email schoolCampus partnerCode').lean();

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

  // 3. DÉDUPLICATION — même email OU même téléphone sur le même campus.
  // Spec §4.1/§9.2 : on ne renvoie PAS d'erreur, on met à jour silencieusement
  // le lead existant. L'attribution partenaire d'origine est conservée (first-touch).
  const dupOr = [{ email: normalizedEmail }];
  if (normalizedPhone) dupOr.push({ phone: normalizedPhone });

  const existingLead = await PartnerLead.findOne({
    schoolCampus:    campusId,
    honeypotTripped: false,
    $or:             dupOr,
  });

  if (existingLead) {
    if (programInterest?.trim()) existingLead.programInterest = programInterest.trim();
    if (normalizedPhone && !existingLead.phone) existingLead.phone = normalizedPhone;
    if (city?.trim())    existingLead.city    = city.trim();
    if (country?.trim()) existingLead.country = country.trim();

    // First-touch : on ne réattribue jamais un lead déjà rattaché à un partenaire.
    if (partner?._id && !existingLead.partner) {
      existingLead.partner     = partner._id;
      existingLead.partnerCode = resolvedCode;
      existingLead.source      = detectedSource;
    }
    if (notifyNextBatch) existingLead.notifyNextBatch = true;

    existingLead.statusHistory.push({
      status:    existingLead.status,
      changedBy: null,
      changedAt: new Date(),
      note:      'Portal re-submission — deduplicated update.',
    });

    await existingLead.save();

    return sendSuccess(res, 200, 'Pre-registration received successfully.', {
      leadId: existingLead._id,
      status: existingLead.status,
    });
  }

  // 4. IP_BURST — >5 leads depuis même IP hash en moins de 10 minutes (spec §9.2)
  const fraudFlags  = [];
  const tenMinAgo   = new Date(Date.now() - 10 * 60 * 1000);
  const burstCount  = await PartnerLead.countDocuments({
    ipAddressHash:   req.ipHash,
    createdAt:       { $gte: tenMinAgo },
    honeypotTripped: false,
  });
  if (burstCount >= 5) fraudFlags.push('IP_BURST');

  const lead = new PartnerLead({
    schoolCampus:    campusId,
    partner:         partner?._id || null,
    partnerCode:     resolvedCode || null,
    firstName:       firstName.trim(),
    lastName:        lastName.trim(),
    email:           normalizedEmail,
    phone:           normalizedPhone,
    programInterest: programInterest?.trim() || null,
    city:            city?.trim() || null,
    country:         country?.trim() || null,
    source:          detectedSource,
    status:          'new',
    statusHistory:   [{ status: 'new', changedBy: null, changedAt: new Date(), note: 'Portal pre-registration.' }],
    utmParams:       utmParams || null,
    ipAddressHash:   req.ipHash,
    honeypotTripped: false,
    fraudFlags,
    notifyNextBatch: notifyNextBatch ? true : false,
  });

  await lead.save();

  if (partner?._id) {
    Partner.findByIdAndUpdate(partner._id, { lastActivityAt: new Date() }).exec().catch(() => {});
  }

  return sendCreated(res, 'Pre-registration received successfully.', {
    leadId: lead._id,
    status: lead.status,
  });
});

module.exports = { publicPreRegister };
