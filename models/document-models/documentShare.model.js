'use strict';

/**
 * @file documentShare.model.js
 * @description Signed, expiring share links for external document access.
 *
 * Security contract (v1.1):
 *   1. Server generates: token = crypto.randomBytes(32).toString('hex')  → 256-bit entropy
 *   2. Server computes:  tokenHash = SHA-256(token)
 *   3. DB stores:        tokenHash ONLY — the plain token is NEVER persisted
 *   4. API returns:      plain token ONCE in the creation response — never retrievable again
 *   5. Verification:     incoming token is hashed and matched against tokenHash in DB
 *   6. Rate limit:       10 req/min/IP enforced on the public share access endpoint
 *   7. IP logging:       every access IP is appended to accessedIps (audit trail)
 *   8. Auto-revoke:      share is considered expired when maxDownloads is reached or expiresAt passed
 *   9. Auto-lock:        if the linked document has isOfficial=true, it auto-locks after first access
 */

const mongoose = require('mongoose');

const DocumentShareSchema = new mongoose.Schema({
  /** Document being shared */
  documentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Document',
    required: true,
  },
  /** Campus scope — required for isolation enforcement */
  campusId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Campus',
    required: true,
  },

  /**
   * SHA-256 hash of the plain token.
   * The plain token is returned once to the caller and never stored.
   * Verification: SHA-256(incomingToken) must match this value.
   */
  tokenHash: { type: String, required: true},

  /**
   * Share link expiry.
   * Default: now + 48h. Maximum: now + 30 days.
   * MongoDB TTL index will auto-delete the share record after this date.
   */
  expiresAt: { type: Date, required: true },

  /** Maximum number of times this link can be used to download the document */
  maxDownloads:  { type: Number, default: 1, min: 1, max: 10 },
  /** Incremented on each successful access */
  downloadCount: { type: Number, default: 0 },

  createdBy: {
    userId:    { type: mongoose.Schema.Types.ObjectId },
    userModel: { type: String, enum: ['Admin', 'Teacher', 'Campus'] },
  },

  /** Audit trail — IP address recorded for every external access event */
  accessedIps: { type: [String], default: [] },

  /** Manual revocation by an authorized user */
  revoked:   { type: Boolean, default: false },
  revokedAt: { type: Date, default: null },
  revokedBy: { type: mongoose.Schema.Types.ObjectId, default: null },

}, {
  timestamps: true,
  versionKey: false,
});

// ── Indexes ───────────────────────────────────────────────────────────────────

/** TTL: MongoDB auto-removes expired share records after expiresAt */
DocumentShareSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
/** Fast token lookup during verification */
DocumentShareSchema.index({ tokenHash: 1 }, { unique: true });
/** List shares for a document */
DocumentShareSchema.index({ documentId: 1 });

const DocumentShare = mongoose.model('DocumentShare', DocumentShareSchema);

module.exports = DocumentShare;