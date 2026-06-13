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

const ContactMessage = require('../../models/contact.message.model');
// Require paresseux vers la facade campus (hub) — voir MODULAR_MONOLITH_MIGRATION.md
const campusSvc = () => require('../../../campus').service;

const {
  asyncHandler,
  sendCreated,
  sendSuccess,
  sendError,
  sendNotFound,
} = require('../../../../shared/utils/response-helpers');

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

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

  // Resolve campus (optional — allows anonymous messages without a ref)
  let campusId = null;
  if (campusSlug?.trim()) {
    const campus = await campusSvc().getActiveCampusBySlug(campusSlug.toLowerCase().trim(), '_id');

    if (!campus) return sendNotFound(res, 'Campus');
    campusId = campus._id;
  }

  const validSubjects = ['registration', 'partnership', 'other'];
  const resolvedSubject = validSubjects.includes(subject) ? subject : 'other';

  const doc = await ContactMessage.create({
    schoolCampus:    campusId,
    name:            name.trim(),
    email:           normalizedEmail,
    phone:           normalizedPhone,
    subject:         resolvedSubject,
    message:         message.trim(),
    ipAddressHash:   req.ipHash,
    honeypotTripped: false,
  });

  return sendCreated(res, 'Message received successfully.', { messageId: doc._id });
});

module.exports = { submitContact };
