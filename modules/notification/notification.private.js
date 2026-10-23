'use strict';

/**
 * @file notification.private.js
 * @description Encrypts bearer-link variables while retaining redacted log snapshots.
 */
const crypto = require('crypto');
const templates = require('./templates');

const PRIVATE_FIELDS = Object.freeze({
  'account.activate': Object.freeze(['link']),
  'admission.access': Object.freeze(['link']),
});

/** Bind ciphertext to its recipient, destination, campus, template and channel. */
const context = (row) => Buffer.from(JSON.stringify([
  String(row.recipientId), row.recipientModel, row.template, row.channel,
  row.to || null, row.schoolCampus ? String(row.schoolCampus) : null,
]));

/** Derive a separate encryption key from the deployment's authentication secret. */
function key() {
  if (!process.env.JWT_SECRET) throw new Error('Notification encryption is not configured');
  return crypto.hkdfSync('sha256', process.env.JWT_SECRET, 'notification', 'private-v1', 32);
}

/** Seal private variables and replace their ordinary snapshots with a fixed marker. */
function protect(row) {
  const fields = PRIVATE_FIELDS[row.template];
  if (!fields) return row;
  const data = { ...row.data };
  const privateData = {};
  for (const field of fields) {
    if (data[field] !== undefined) privateData[field] = data[field];
    data[field] = '[private link]';
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(context(row));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(privateData)), cipher.final()]);
  const privatePayload = [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
  return {
    ...row, data, privatePayload,
    ...templates.render(row.template, row.channel, data, row.locale),
  };
}

/** Render private content only for a delivery or the authenticated recipient's inbox. */
function reveal(row) {
  if (!row.privatePayload) return row;
  const [iv, tag, encrypted] = row.privatePayload.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAAD(context(row));
  decipher.setAuthTag(tag);
  const data = {
    ...row.data,
    ...JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')),
  };
  return { ...row, data, ...templates.render(row.template, row.channel, data, row.locale) };
}

/** Never include encrypted delivery material in API results or ordinary logs. */
function publicRow(doc) {
  const { privatePayload: _private, ...row } = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return row;
}

module.exports = { protect, reveal, publicRow, PRIVATE_FIELDS };
