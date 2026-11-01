'use strict';
/** @file whatsapp.controller.js @description Public signed callbacks and authenticated self-service/management surfaces. */
const service = require('../whatsapp.service');
const config = require('../../../shared/configs/general.config');
const { buildCampusFilter, isValidObjectId } = require('../../../shared/utils/validation-helpers');
const { asyncHandler, sendSuccess, sendError, sendForbidden, sendValidationError } = require('../../../shared/utils/response-helpers');
/** Read the authenticated caller's consent; body/query identities are never accepted. */
const getConsent = asyncHandler(async (req, res) => sendSuccess(res, 200, 'WhatsApp consent retrieved', await service.getConsent(req.user)));
/** Grant or withdraw the caller's consent. */
const updateConsent = asyncHandler(async (req, res) => {
  try { return sendSuccess(res, 200, 'WhatsApp consent updated', await service.updateConsent(req.user, req.body)); }
  catch (error) { if (error.statusCode === 400) return sendError(res, 400, error.message); throw error; }
});
/** Read one explicitly selected management campus, using the canonical identity scope helper. */
const usage = asyncHandler(async (req, res) => {
  let filter;
  try { filter = buildCampusFilter(req.user, req.query.campusId); }
  catch (error) { return sendForbidden(res, error.message); }
  const campusId = filter.schoolCampus;
  if (!isValidObjectId(campusId)) return sendValidationError(res, [{ field: 'campusId', message: 'Select a valid campus' }]);
  return sendSuccess(res, 200, 'WhatsApp monthly usage retrieved', await service.getUsage(campusId));
});
/** Meta verification handshake, deliberately plain text as required by the protocol. */
const verify = (req, res) => {
  // The global Mongo sanitizer replaces dots in parsed query keys. Meta's
  // dotted protocol keys are read from the original URL, never used in queries.
  const query = new URL(req.originalUrl, 'http://localhost').searchParams;
  const challenge = query.get('hub.challenge');
  if (query.get('hub.mode') !== 'subscribe' || typeof challenge !== 'string'
    || challenge.length > 200 || !service.equalSecret(query.get('hub.verify_token'), config.notification.whatsapp.verifyToken)) {
    return sendForbidden(res, 'Webhook verification refused');
  }
  return res.status(200).type('text/plain').send(challenge);
};
/** Authenticate exact raw bytes before parsing callback data; failures remain retryable to Meta. */
const receive = asyncHandler(async (req, res) => {
  if (!service.validSignature(req.whatsappRawBody, req.get('x-hub-signature-256'))) return sendForbidden(res, 'Invalid webhook signature');
  await service.receive(JSON.parse(req.whatsappRawBody.toString('utf8')));
  return sendSuccess(res, 200, 'Webhook received');
});
module.exports = { getConsent, updateConsent, usage, verify, receive };
