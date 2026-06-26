'use strict';

/**
 * @file public.contact.controller.js
 * @description Contact form submission (spec §4.8).
 *
 * Route: POST /api/public/contact
 *
 * Fields: name, email OR phone (at least one), message, subject, campusSlug, honeypot
 * Creates a ContactMessage document. Rate-limited to 5 req/h/IP via the caller.
 */

const { enqueueIngestion } = require('../../public-portal.queue');
// Lazy require to the campus facade (hub) — see MODULAR_MONOLITH_MIGRATION.md
const campusSvc = () => require('../../../campus').service;

const {
  asyncHandler,
  sendSuccess,
  sendError,
  sendNotFound,
} = require('../../../../shared/utils/response-helpers');
const { firstLengthViolation } = require('../../../../shared/utils/validation-helpers');

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// Synchronous input bounds — must mirror the ContactMessage model. Validating
// here (before the deferred write) returns a 400 immediately; a model
// ValidationError would otherwise surface only in the ingestion worker, after a
// 202 was already sent, silently dropping the message.
const CONTACT_BOUNDS = { name: 120, email: 160, phone: 30, message: 2000 };

const submitContact = asyncHandler(async (req, res) => {
  const {
    name, email, phone, subject, message, campusSlug, honeypot,
  } = req.body;

  // Silent honeypot discard
  if (honeypot) {
    return sendSuccess(res, 200, 'Message received.');
  }

  if (!name?.trim())    return sendError(res, 400, 'name is required.');
  if (!message?.trim()) return sendError(res, 400, 'message is required.');

  const normalizedEmail = email?.trim() ? email.toLowerCase().trim() : null;
  const normalizedPhone = phone?.trim() || null;

  if (!normalizedEmail && !normalizedPhone) {
    return sendError(res, 400, 'An email address or phone number is required.');
  }

  if (normalizedEmail && !EMAIL_REGEX.test(normalizedEmail)) {
    return sendError(res, 400, 'A valid email address is required.');
  }

  const tooLong = firstLengthViolation([
    { field: 'name',    value: name,            max: CONTACT_BOUNDS.name },
    { field: 'email',   value: normalizedEmail, max: CONTACT_BOUNDS.email },
    { field: 'phone',   value: normalizedPhone, max: CONTACT_BOUNDS.phone },
    { field: 'message', value: message,         max: CONTACT_BOUNDS.message },
  ]);
  if (tooLong) {
    return sendError(res, 400, `${tooLong.field} must not exceed ${tooLong.max} characters.`);
  }

  // Resolve campus (optional — allows anonymous messages without a ref)
  let campusId = null;
  if (campusSlug?.trim()) {
    const campus = await campusSvc().getActiveCampusBySlug(campusSlug.toLowerCase().trim(), '_id');

    if (!campus) return sendNotFound(res, 'Campus');
    campusId = campus._id;
  }

  const validSubjects = ['registration', 'partnership', 'other'];
  const resolvedSubject = validSubjects.includes(subject) ? subject : 'other';

  // Persistence deferred to the ingestion queue (worker calls
  // repo.createContactMessage). 202 Accepted — the portal treats any 2xx as
  // success and does not read the message id back.
  await enqueueIngestion({
    type: 'contact',
    payload: {
      schoolCampus:    campusId,
      name:            name.trim(),
      email:           normalizedEmail,
      phone:           normalizedPhone,
      subject:         resolvedSubject,
      message:         message.trim(),
      ipAddressHash:   req.ipHash,
      honeypotTripped: false,
    },
  });

  return sendSuccess(res, 202, 'Message received successfully.');
});

module.exports = { submitContact };
