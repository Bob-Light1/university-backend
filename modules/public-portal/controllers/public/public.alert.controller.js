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
const { firstLengthViolation } = require('../../../../shared/utils/validation-helpers');
const { enqueueIngestion } = require('../../public-portal.queue');
// Lazy require to the campus facade (hub) — see MODULAR_MONOLITH_MIGRATION.md
const campusSvc = () => require('../../../campus').service;

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// Synchronous input bounds for the deferred lead write (see the ingestion queue).
const ALERT_BOUNDS = { email: 160, phone: 30, programInterest: 120 };

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

  const tooLong = firstLengthViolation([
    { field: 'email',           value: normalizedEmail,         max: ALERT_BOUNDS.email },
    { field: 'phone',           value: normalizedPhone,         max: ALERT_BOUNDS.phone },
    { field: 'programInterest', value: programInterest?.trim(), max: ALERT_BOUNDS.programInterest },
  ]);
  if (tooLong) {
    return sendError(res, 400, `${tooLong.field} must not exceed ${tooLong.max} characters.`);
  }

  const defaultSlug = process.env.DEFAULT_CAMPUS_SLUG ?? '';
  const slug = campusSlug?.trim() || defaultSlug;

  const campus = await campusSvc().getActiveCampusBySlug(slug, '_id');
  if (!campus) {
    return sendError(res, 404, 'Campus not found.');
  }

  // Persistence deferred to the ingestion queue: existing lead → notifyNextBatch
  // = true; otherwise a minimal lead is created (partner module, in the worker).
  // 202 Accepted — the portal treats any 2xx as success.
  await enqueueIngestion({
    type: 'alert',
    payload: {
      campusId:        campus._id,
      email:           normalizedEmail,
      phone:           normalizedPhone,
      programInterest: programInterest?.trim() || null,
      ipAddressHash:   req.ipHash,
    },
  });

  return sendSuccess(res, 202, 'Alert registered.');
});

module.exports = { submitAlert };
