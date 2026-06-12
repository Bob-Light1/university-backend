'use strict';

/**
 * POST /api/public/alert
 *
 * Lightweight session-alert opt-in (spec §4.13).
 * Accepts email OR phone + optional campusSlug + optional program.
 * - Existing lead found by email/phone on the campus → sets notifyNextBatch = true.
 * - No existing lead → creates a minimal PartnerLead with notifyNextBatch = true.
 */

const { asyncHandler, sendSuccess, sendError } = require('../../../../shared/utils/response-helpers');
const partnerService = require('../../../partner').service; // façade module partner (§3)
const Campus         = require('../../../../models/campus.model');

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

const submitAlert = asyncHandler(async (req, res) => {
  const {
    email, phone,
    campusSlug,
    programInterest,
    honeypot,
  } = req.body;

  if (honeypot) {
    return sendSuccess(res, 200, 'Alert registered.');
  }

  const normalizedEmail = email?.toLowerCase().trim() || null;
  const normalizedPhone = phone?.trim() || null;

  if (!normalizedEmail && !normalizedPhone) {
    return sendError(res, 400, 'An email or phone number is required.');
  }
  if (normalizedEmail && !EMAIL_REGEX.test(normalizedEmail)) {
    return sendError(res, 400, 'Invalid email address.');
  }

  const defaultSlug = process.env.DEFAULT_CAMPUS_SLUG ?? '';
  const slug = campusSlug?.trim() || defaultSlug;

  const campus = await Campus.findOne({ campusSlug: slug, status: 'active' }).select('_id').lean();
  if (!campus) {
    return sendError(res, 404, 'Campus not found.');
  }

  // Lead existant → notifyNextBatch=true ; sinon lead minimal créé (module partner).
  const { leadId, created } = await partnerService.registerSessionAlert({
    campusId:        campus._id,
    email:           normalizedEmail,
    phone:           normalizedPhone,
    programInterest: programInterest?.trim() || null,
    ipAddressHash:   req.ipHash,
  });

  return sendSuccess(res, created ? 201 : 200, 'Alert registered.', { leadId });
});

module.exports = { submitAlert };
