'use strict';
/** @file whatsapp.constants.js @description WhatsApp protocol and consent vocabulary. */
const CONSENT_VERSION = '2026-11-01';
const DELIVERY = Object.freeze({ UNKNOWN: 'unknown', ACCEPTED: 'accepted', SENT: 'sent', FAILED: 'failed', DELIVERED: 'delivered', READ: 'read' });
const DELIVERY_RANK = Object.freeze({ unknown: 0, accepted: 1, sent: 2, failed: 3, delivered: 4, read: 5 });
const REASONS = Object.freeze({
  CONSENT: 'WHATSAPP_CONSENT_REQUIRED', TEMPLATE: 'WHATSAPP_TEMPLATE_UNAVAILABLE',
  QUOTA: 'WHATSAPP_QUOTA_EXHAUSTED', CAMPUS: 'WHATSAPP_CAMPUS_REQUIRED',
  UNKNOWN: 'WHATSAPP_SUBMISSION_UNCERTAIN', FAILED: 'WHATSAPP_SUBMISSION_FAILED',
  CONFIG: 'WHATSAPP_NOT_CONFIGURED', PHONE: 'WHATSAPP_PHONE_REQUIRED', MODULE: 'WHATSAPP_MODULE_DISABLED',
});
const TEMPLATE_PARAMETERS = Object.freeze({
  'result.published': Object.freeze([]), 'exam.graded': Object.freeze([]),
  'fraud.alert': Object.freeze(['count']),
  'payment.reminder': Object.freeze(['amount', 'currency', 'dueDate']),
  'payment.due_in_7d': Object.freeze(['amount', 'currency', 'dueDate']),
  'payment.due_in_3d': Object.freeze(['amount', 'currency', 'dueDate']),
  'payment.due_today': Object.freeze(['amount', 'currency', 'dueDate']),
});
const META_LANGUAGES = Object.freeze({ en: 'en', fr: 'fr', ar: 'ar', de: 'de', es: 'es', it: 'it', ja: 'ja', pt: 'pt_PT', ru: 'ru', 'zh-CN': 'zh_CN' });
/** Canonical phone identity; never infer a country from a local number. */
const normalizePhone = (value) => {
  if (typeof value !== 'string' || !/^\+?[1-9][\d ()-]{6,23}$/.test(value)) return null;
  const digits = value.replace(/[^\d]/g, '');
  return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : null;
};
module.exports = { CONSENT_VERSION, DELIVERY, DELIVERY_RANK, REASONS, TEMPLATE_PARAMETERS, META_LANGUAGES, normalizePhone };
