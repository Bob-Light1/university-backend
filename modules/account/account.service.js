'use strict';

/**
 * @file account.service.js
 * @description Cross-module account-activation service.
 *
 * Public API (consumed by every user-facing module + the bulk importer):
 *   - issueActivationToken(...) : create a token, notify (if email), return the
 *                                 plain link + short code ONCE for offline delivery.
 *   - inspectToken(token)       : validate a link token (frontend pre-check).
 *   - activateAccount(...)      : set the user-chosen password + flip status → 'active'.
 *
 * The plain token/code are never stored. Target accounts are resolved by name via
 * mongoose.model(userModel) — no direct cross-module file requires, no circular deps.
 */

const crypto   = require('crypto');
const bcrypt   = require('bcrypt');
const mongoose = require('mongoose');

const ActivationToken = require('./account.activation.model');
const { validatePasswordStrength } = require('../../shared/utils/validation-helpers');

const SALT_ROUNDS = 12;
const TTL_HOURS   = 72;
const MAX_CODE_ATTEMPTS = 8;

// Unambiguous alphabet for the offline code (no 0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH   = 8;

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/** Frontend base URL used to build the activation link. */
const frontendBaseUrl = () => {
  const raw = process.env.FRONTEND_URL || process.env.APP_URL || process.env.BASE_URL || '';
  return String(raw).split(',')[0].trim().replace(/\/$/, '');
};

/** Generates a short, human-typable activation code. */
const generateShortCode = () => {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
};

const normalizeCode = (code) => String(code || '').trim().toUpperCase().replace(/[\s-]/g, '');

/**
 * Issues an activation token for a freshly created (pending) account.
 * Best-effort notification when an email is present; the link + short code are
 * always returned to the caller so an admin can deliver them offline.
 *
 * @param {Object} params
 * @param {string} params.userModel  One of ActivationToken.ACTIVATION_MODELS
 * @param {string} params.userId     Target account _id
 * @param {string} [params.campusId] Campus scope
 * @param {string} [params.email]    Recipient email (enables the email channel)
 * @param {string} [params.name]     First name for the greeting
 * @param {string} [params.locale]   Recipient locale
 * @param {string} [params.createdBy] Admin _id (audit)
 * @returns {Promise<{ activationUrl: string, code: string, expiresAt: Date }>}
 */
async function issueActivationToken({ userModel, userId, campusId = null, email = null, name = '', locale, createdBy = null }) {
  if (!ActivationToken.ACTIVATION_MODELS.includes(userModel)) {
    throw new Error(`issueActivationToken: unsupported userModel '${userModel}'`);
  }

  // Invalidate any previous unused token for this account (single live link).
  await ActivationToken.deleteMany({ userModel, userId, usedAt: null });

  const token     = crypto.randomBytes(32).toString('hex');
  const code      = generateShortCode();
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000);

  await ActivationToken.create({
    userModel,
    userId,
    campusId,
    tokenHash: sha256(token),
    codeHash:  sha256(code),
    expiresAt,
    createdBy,
  });

  const activationUrl = `${frontendBaseUrl()}/activate/${token}`;

  // Fire-and-forget email + in-app notification. Inert without SMTP — never blocks.
  if (email) {
    require('../notification').service.notify({
      recipient: { id: userId, model: userModel, email, campusId },
      channels:  ['inapp', 'email'],
      template:  'account.activate',
      data:      { name: name || '', link: activationUrl },
      locale,
    }).catch((err) => console.error('[notify] account.activate failed:', err.message));
  }

  // Returned ONCE — never retrievable again (only hashes are stored).
  return { activationUrl, code, expiresAt };
}

/**
 * Validates a link token without consuming it (frontend pre-check).
 * @param {string} token Plain URL token
 * @returns {Promise<{ userModel: string, firstName: string }|null>}
 */
async function inspectToken(token) {
  if (!token) return null;
  const record = await ActivationToken.findOne({
    tokenHash: sha256(token),
    usedAt:    null,
    expiresAt: { $gt: new Date() },
  });
  if (!record) return null;

  const Model   = mongoose.model(record.userModel);
  const account = await Model.findById(record.userId).select('firstName status').lean();
  if (!account) return null;

  return { userModel: record.userModel, firstName: account.firstName || '' };
}

/**
 * Activates an account by setting the user-chosen password.
 *
 * Two entry modes:
 *   - link mode    : { token, password }
 *   - offline mode : { identifier, code, password }  (identifier = username | email | matricule)
 *
 * Throws an Error whose `.code` is one of:
 *   WEAK_PASSWORD · MISSING_CREDENTIALS · INVALID_OR_EXPIRED · IDENTIFIER_MISMATCH · TOO_MANY_ATTEMPTS
 *
 * @returns {Promise<{ userModel: string, userId: string }>}
 */
async function activateAccount({ token = null, identifier = null, code = null, password }) {
  const strength = validatePasswordStrength(password);
  if (!strength.valid) {
    const err = new Error('Password does not meet the security policy.');
    err.code = 'WEAK_PASSWORD';
    err.errors = strength.errors;
    throw err;
  }

  const now = new Date();
  let record = null;
  let viaCode = false;

  if (token) {
    record = await ActivationToken.findOne({ tokenHash: sha256(token), usedAt: null, expiresAt: { $gt: now } });
  } else if (code && identifier) {
    viaCode = true;
    record = await ActivationToken.findOne({ codeHash: sha256(normalizeCode(code)), usedAt: null, expiresAt: { $gt: now } });
  } else {
    const err = new Error('An activation link or an identifier + code is required.');
    err.code = 'MISSING_CREDENTIALS';
    throw err;
  }

  if (!record) {
    const err = new Error('This activation link or code is invalid or has expired.');
    err.code = 'INVALID_OR_EXPIRED';
    throw err;
  }

  if (record.attempts >= MAX_CODE_ATTEMPTS) {
    const err = new Error('Too many failed attempts. Ask an administrator to re-issue your activation code.');
    err.code = 'TOO_MANY_ATTEMPTS';
    throw err;
  }

  const Model   = mongoose.model(record.userModel);
  const account = await Model.findById(record.userId).select('username email matricule status');
  if (!account) {
    const err = new Error('This activation link or code is invalid or has expired.');
    err.code = 'INVALID_OR_EXPIRED';
    throw err;
  }

  // Offline mode: the identifier is a second factor confirming the right person.
  if (viaCode) {
    const supplied = String(identifier).trim().toLowerCase();
    const known = [account.username, account.email, account.matricule]
      .filter(Boolean)
      .map((v) => String(v).toLowerCase());
    if (!known.includes(supplied)) {
      record.attempts += 1;
      await record.save();
      const err = new Error('The identifier does not match this activation code.');
      err.code = 'IDENTIFIER_MISMATCH';
      throw err;
    }
  }

  // Hash here (not via the pre-save hook) to avoid re-triggering each model's
  // cross-entity save hooks. Flip status only if the account is still pending.
  const hashed = await bcrypt.hash(password, SALT_ROUNDS);
  const update = { password: hashed };
  if (account.status === 'pending') update.status = 'active';
  await Model.updateOne({ _id: account._id }, { $set: update });

  record.usedAt = now;
  await record.save();

  return { userModel: record.userModel, userId: String(record.userId) };
}

module.exports = {
  issueActivationToken,
  inspectToken,
  activateAccount,
  TTL_HOURS,
};
