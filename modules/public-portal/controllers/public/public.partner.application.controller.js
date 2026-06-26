'use strict';

/**
 * @file public.partner.application.controller.js
 * @description Public partner application (spec §4.9 / §7.9).
 *
 * Route: POST /api/public/partner-application
 *
 * Creates a PartnerApplication with status 'pending'.
 * The admin reviews it from /api/portal-admin/applications.
 */

const partnerService = require('../../../partner').service; // partner module facade (§3)
// Lazy require to the campus facade (hub) — see MODULAR_MONOLITH_MIGRATION.md
const campusSvc = () => require('../../../campus').service;

const {
  asyncHandler,
  sendCreated,
  sendSuccess,
  sendError,
  sendNotFound,
} = require('../../../../shared/utils/response-helpers');
const { firstLengthViolation } = require('../../../../shared/utils/validation-helpers');

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// Input bounds for the public application — protects against oversized writes.
const APPLICATION_BOUNDS = { firstName: 80, lastName: 80, email: 160, phone: 30, message: 2000 };

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

  const tooLong = firstLengthViolation([
    { field: 'firstName', value: firstName,       max: APPLICATION_BOUNDS.firstName },
    { field: 'lastName',  value: lastName,        max: APPLICATION_BOUNDS.lastName },
    { field: 'email',     value: normalizedEmail, max: APPLICATION_BOUNDS.email },
    { field: 'phone',     value: phone,           max: APPLICATION_BOUNDS.phone },
    { field: 'message',   value: message,         max: APPLICATION_BOUNDS.message },
  ]);
  if (tooLong) {
    return sendError(res, 400, `${tooLong.field} must not exceed ${tooLong.max} characters.`);
  }

  // Resolve campus (optional, but encouraged to associate the application)
  let campusId = null;
  if (campusSlug?.trim()) {
    const campus = await campusSvc().getActiveCampusBySlug(campusSlug.toLowerCase().trim(), '_id');

    if (!campus) return sendNotFound(res, 'Campus');
    campusId = campus._id;
  }

  const validTypes    = ['influencer', 'church_leader', 'student_leader', 'teacher', 'parent', 'other'];
  const validChannels = ['online', 'offline', 'hybrid'];

  const { applicationId } = await partnerService.createApplication({
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

  return sendCreated(res, 'Partner application submitted successfully.', { applicationId });
});

module.exports = { submitPartnerApplication };
