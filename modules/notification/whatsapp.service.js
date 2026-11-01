'use strict';
/** @file whatsapp.service.js @description Consent, cost boundary and authenticated provider receipt orchestration. */
const crypto = require('node:crypto');
const repo = require('./whatsapp.repository');
const notifications = require('./notification.repository');
const templates = require('./whatsapp.templates');
const config = require('../../shared/configs/general.config');
const { WHATSAPP_MONTHLY_LIMITS } = require('../../shared/constants/features.constants');
const { CONSENT_VERSION, DELIVERY_RANK, REASONS, normalizePhone } = require('../../shared/constants/whatsapp.constants');
const { isValidObjectId } = require('../../shared/utils/validation-helpers');
const settings = () => require('../settings').service.whatsappConsent;
const monthOf = (now = new Date()) => now.toISOString().slice(0, 7);
/** Expose only the authenticated caller's own stored consent. */
const getConsent = (user) => settings().read(settings().identity(user));
/** Deliberate self-service grant/revocation. */
const updateConsent = (user, input) => settings().update(user, input);
/** Read current tier; a missing/unknown/custom plan grants no paid provider budget. */
async function allowance(campusId) {
  const campus = await require('../campus').service.getCampusEntitlement(campusId);
  const plan = campus?.entitlement?.plan || null;
  return { plan, limit: WHATSAPP_MONTHLY_LIMITS[plan] || 0 };
}
/** Management usage surface; controller already derives and validates campus scope. */
async function getUsage(campusId) {
  const month = monthOf();
  const [{ plan, limit }, row] = await Promise.all([allowance(campusId), repo.usage(campusId, month)]);
  const used = row?.used || 0;
  return { campusId: String(campusId), month, plan, limit, used, remaining: Math.max(0, limit - used) };
}
/** Preflight immediately before submission; skip codes contain no contact/provider secrets. */
async function prepare(doc) {
  if (!doc.schoolCampus) return { reason: REASONS.CAMPUS };
  if (doc.whatsapp?.submissionStartedAt) return { reason: REASONS.UNKNOWN };
  const phone = normalizePhone(doc.to);
  const consent = await settings().read({ userId: doc.recipientId, userModel: doc.recipientModel, campusId: doc.schoolCampus });
  if (!phone || !consent.enabled || !consent.grantedAt || consent.revokedAt || consent.version !== CONSENT_VERSION || consent.phone !== phone) return { reason: REASONS.CONSENT };
  const template = templates.resolve(doc.template, doc.locale, doc.data);
  if (!template) return { reason: REASONS.TEMPLATE };
  const { limit } = await allowance(doc.schoolCampus);
  if (!(await repo.reserve(doc.schoolCampus, monthOf(), limit))) return { reason: REASONS.QUOTA };
  return { template };
}
/** Compare externally supplied tokens/signatures in constant time without throwing. */
function equalSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/** Validate the exact bytes before parsing or processing Meta data. */
function validSignature(raw, signature) {
  const secret = config.notification.whatsapp.appSecret;
  if (!secret || !Buffer.isBuffer(raw) || typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  return equalSecret(signature, `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`);
}
/** Ignore unrelated payloads; only known receipts for this deployment can mutate rows. */
async function receive(body) {
  if (body?.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return;
  for (const entry of body.entry) for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
    const value = change.value;
    if (change.field !== 'messages' || value?.metadata?.phone_number_id !== config.notification.whatsapp.phoneNumberId) continue;
    for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
      const rank = DELIVERY_RANK[status.status];
      const phone = normalizePhone(status.recipient_id);
      if (!['sent', 'delivered', 'read', 'failed'].includes(status.status) || !rank || !phone
        || typeof status.id !== 'string' || !status.id || status.id.length > 300
        || !/^\d{1,12}$/.test(String(status.timestamp))) continue;
      const at = new Date(Number(status.timestamp) * 1000);
      if (!Number.isFinite(at.getTime())) continue;
      const callbackId = status.biz_opaque_callback_data;
      if (callbackId !== undefined && !isValidObjectId(callbackId)) continue;
      await notifications.recordWhatsappStatus({ notificationId: callbackId, messageId: status.id,
        phoneNumberId: value.metadata.phone_number_id, phone, status: status.status, rank, at });
    }
  }
}
module.exports = { getConsent, updateConsent, getUsage, prepare, equalSecret, validSignature, receive };
