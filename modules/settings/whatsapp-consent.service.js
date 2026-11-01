'use strict';
/** @file whatsapp-consent.service.js @description Explicit, phone-bound permission owned by authenticated identity. */
const repo = require('./settings.repository');
const { CONSENT_VERSION, normalizePhone } = require('../../shared/constants/whatsapp.constants');
const MODELS = require('./settings.constants').USER_MODELS;
/** Derive the storage discriminator from authenticated identity only. */
const identity = (user) => ({ userId: user.id, userModel: MODELS[user.role], campusId: user.campusId || null });
/** Read only the requested recipient's current, correctly scoped consent. */
async function read({ userId, userModel, campusId = null }) {
  const row = await repo.findByUserId(userId);
  const matches = row && row.userModel === userModel && String(row.campusId || '') === String(campusId || '');
  return { enabled: false, phone: null, version: CONSENT_VERSION, ...(matches && row.whatsappConsent), currentVersion: CONSENT_VERSION };
}
/** Persist a deliberate grant/revocation; legacy preferences are never promoted. */
async function update(user, input) {
  const who = identity(user);
  const phone = normalizePhone(input.phone);
  if (!who.userModel || typeof input.enabled !== 'boolean'
    || (input.enabled && (!phone || !input.phone.startsWith('+') || input.version !== CONSENT_VERSION))) {
    throw Object.assign(new Error('Explicit consent, current version and an international phone number are required'), { statusCode: 400 });
  }
  const previous = await read(who);
  const now = new Date();
  const whatsappConsent = input.enabled
    ? { enabled: true, phone, version: CONSENT_VERSION, grantedAt: now, revokedAt: null }
    : { enabled: false, phone: previous.phone, version: previous.version, grantedAt: previous.grantedAt || null, revokedAt: now };
  await repo.upsertWithSet(who.userId, { whatsappConsent, userModel: who.userModel, campusId: who.campusId }, { userId: who.userId });
  return { ...whatsappConsent, currentVersion: CONSENT_VERSION };
}
module.exports = { identity, read, update };
