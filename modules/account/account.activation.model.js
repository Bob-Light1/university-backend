'use strict';

/**
 * @file account.activation.model.js
 * @description Single-use, expiring account-activation tokens shared by every
 *              user-facing module (Mentor · Staff · Student · Teacher · Parent).
 *
 * Security contract (mirrors document.share.model.js):
 *   1. Server generates a long URL token  : crypto.randomBytes(32).toString('hex')  → 256-bit entropy
 *   2. Server generates a short offline code : 8 chars, no ambiguous glyphs
 *   3. DB stores ONLY the SHA-256 hashes — the plain token/code are NEVER persisted
 *   4. The plain token + code are returned ONCE to the creating admin (offline delivery)
 *      and, when an email exists, the link is also sent via the `account.activate` notification
 *   5. Verification: SHA-256(incoming) must match the stored hash; the record must be
 *      unused (`usedAt = null`) and not expired
 *   6. TTL index auto-removes the record once `expiresAt` is passed
 *
 * No password is ever transmitted in clear text: the user chooses their own
 * password through the activation flow, which also flips `status` → 'active'.
 */

const mongoose = require('mongoose');

/** User collections that support activation. Maps 1:1 to mongoose model names. */
const ACTIVATION_MODELS = Object.freeze(['Mentor', 'Staff', 'Student', 'Teacher', 'Parent']);

const ActivationTokenSchema = new mongoose.Schema(
  {
    /** Target collection — drives mongoose.model(userModel) resolution */
    userModel: { type: String, enum: ACTIVATION_MODELS, required: true },
    /** Target account _id */
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    /** Campus scope (for audit / future isolation); null for global accounts */
    campusId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campus', default: null },

    /** SHA-256 of the long URL token (email / link channel) */
    tokenHash: { type: String, required: true, index: true },
    /** SHA-256 of the short human-typable code (offline channel) */
    codeHash: { type: String, required: true, index: true },

    /** Expiry — TTL index removes the record once passed */
    expiresAt: { type: Date, required: true },
    /** Set once the token is consumed; a used token can never be replayed */
    usedAt: { type: Date, default: null },
    /** Failed short-code confirmation attempts — brute-force guard */
    attempts: { type: Number, default: 0 },

    /** Admin who triggered the issuance (audit) */
    createdBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

// TTL: MongoDB auto-deletes the record as soon as expiresAt is in the past.
ActivationTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Fast invalidation of previous tokens when a new one is issued for an account.
ActivationTokenSchema.index({ userModel: 1, userId: 1 });

const ActivationToken = mongoose.model('ActivationToken', ActivationTokenSchema);

ActivationToken.ACTIVATION_MODELS = ACTIVATION_MODELS;

module.exports = ActivationToken;
