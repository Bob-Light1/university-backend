'use strict';

/**
 * @file public.partner.application.controller.js
 * @description Candidature partenaire publique (spec §4.9 / §7.9).
 *
 * Route: POST /api/public/partner-application
 *
 * Creates a PartnerApplication with status 'pending'.
 * The admin reviews it from /api/portal-admin/applications.
 */

const PartnerApplication = require('../../models/partner-models/partner.application.model');
const Campus             = require('../../models/campus.model');

const {
  asyncHandler,
  sendCreated,
  sendSuccess,
  sendError,
  sendNotFound,
} = require('../../utils/response-helpers');

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

const submitPartnerApplication = asyncHandler(async (req, res) => {
  const {
    firstName, lastName, email, phone,
    commercialType, channelType, message,
    campusSlug, honeypot,
  } = req.body;

  // Silent honeypot discard
  if (honeypot) {
    return sendSuccess(res, 200, 'Application received.');
  }

  // Required field validation
  if (!firstName?.trim()) return sendError(res, 400, 'firstName is required.');
  if (!lastName?.trim())  return sendError(res, 400, 'lastName is required.');
  if (!email?.trim())     return sendError(res, 400, 'email is required.');

  const normalizedEmail = email.toLowerCase().trim();

  if (!EMAIL_REGEX.test(normalizedEmail)) {
    return sendError(res, 400, 'A valid email address is required.');
  }

  // Resolve campus (optional, but encouraged to associate the application)
  let campusId = null;
  if (campusSlug?.trim()) {
    const campus = await Campus.findOne({
      campusSlug: campusSlug.toLowerCase().trim(),
      status:     'active',
    }).select('_id').lean();

    if (!campus) return sendNotFound(res, 'Campus');
    campusId = campus._id;
  }

  const validTypes    = ['influencer', 'church_leader', 'student_leader', 'teacher', 'parent', 'other'];
  const validChannels = ['online', 'offline', 'hybrid'];

  const doc = await PartnerApplication.create({
    schoolCampus:    campusId,
    firstName:       firstName.trim(),
    lastName:        lastName.trim(),
    email:           normalizedEmail,
    phone:           phone?.trim() || null,
    commercialType:  validTypes.includes(commercialType) ? commercialType : 'other',
    channelType:     validChannels.includes(channelType) ? channelType : 'hybrid',
    message:         message?.trim() || null,
    ipAddressHash:   req.ipHash,
    honeypotTripped: false,
  });

  return sendCreated(res, 'Partner application submitted successfully.', { applicationId: doc._id });
});

module.exports = { submitPartnerApplication };
