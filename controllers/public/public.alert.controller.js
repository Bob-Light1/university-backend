'use strict';

/**
 * POST /api/public/alert
 *
 * Lightweight session-alert opt-in (spec §4.13).
 * Accepts email OR phone + optional campusSlug + optional program.
 * - Existing lead found by email/phone on the campus → sets notifyNextBatch = true.
 * - No existing lead → creates a minimal PartnerLead with notifyNextBatch = true.
 */

const { asyncHandler, sendSuccess, sendError } = require('../../utils/response-helpers');
const PartnerLead = require('../../models/partner-models/partner.lead.model');
const Campus      = require('../../models/campus.model');

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

  // Try to find existing lead by email or phone on this campus.
  let lead = null;
  if (normalizedEmail) {
    lead = await PartnerLead.findOne({ email: normalizedEmail, schoolCampus: campus._id });
  }
  if (!lead && normalizedPhone) {
    lead = await PartnerLead.findOne({ phone: normalizedPhone, schoolCampus: campus._id });
  }

  if (lead) {
    lead.notifyNextBatch = true;
    if (programInterest?.trim() && !lead.programInterest) {
      lead.programInterest = programInterest.trim();
    }
    await lead.save();
    return sendSuccess(res, 200, 'Alert registered.', { leadId: lead._id });
  }

  // Create a minimal lead for visitors who haven't pre-registered yet.
  const newLead = new PartnerLead({
    schoolCampus:    campus._id,
    firstName:       'Alert',
    lastName:        'Subscriber',
    email:           normalizedEmail || `alert-${Date.now()}@noemail.local`,
    phone:           normalizedPhone,
    programInterest: programInterest?.trim() || null,
    source:          'direct',
    status:          'new',
    statusHistory:   [{ status: 'new', changedBy: null, changedAt: new Date(), note: 'Session alert opt-in.' }],
    ipAddressHash:   req.ipHash,
    honeypotTripped: false,
    notifyNextBatch: true,
  });

  await newLead.save();
  return sendSuccess(res, 201, 'Alert registered.', { leadId: newLead._id });
});

module.exports = { submitAlert };
