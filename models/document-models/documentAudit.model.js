'use strict';

/**
 * @file documentAudit.model.js
 * @description Standalone append-only audit log for all document events.
 *
 * Design decisions:
 * - This is the SOLE source of truth for document audit history.
 * - The Document schema contains only lastAuditEntry (single object) for fast display.
 * - No array in Document schema → prevents 16 MB BSON overflow on heavily-modified documents.
 * - Append-only enforced via pre-hooks that throw on any delete attempt.
 * - Audit records are NEVER hard-deleted, even when the parent document is removed.
 */

const mongoose = require('mongoose');

// ── Audit Action Enum ─────────────────────────────────────────────────────────

const AUDIT_ACTION = Object.freeze({
  CREATE:            'CREATE',
  UPDATE:            'UPDATE',
  DELETE:            'DELETE',
  PUBLISH:           'PUBLISH',
  ARCHIVE:           'ARCHIVE',
  RESTORE:           'RESTORE',
  DUPLICATE:         'DUPLICATE',
  DOWNLOAD:          'DOWNLOAD',
  SHARE:             'SHARE',
  PRINT:             'PRINT',
  VERSION_RESTORE:   'VERSION_RESTORE',
  LOCK:              'LOCK',
  UNLOCK:            'UNLOCK',
  IMPORT:            'IMPORT',
  TEMPLATE_GENERATE: 'TEMPLATE_GENERATE',
});

// ── Schema ────────────────────────────────────────────────────────────────────

const DocumentAuditSchema = new mongoose.Schema({
  /** Reference to the audited document. Retained even if the document is soft-deleted. */
  documentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Document',
    required: true,
  },
  /** Campus scope — allows campus-level audit queries without joining Document */
  campusId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Campus',
    required: true,
    index: true,
  },

  action:      { type: String, enum: Object.values(AUDIT_ACTION), required: true },
  performedBy: { type: mongoose.Schema.Types.ObjectId, required: true },
  /** Discriminator to determine which collection to look up the performer in */
  userModel:   { type: String, enum: ['Admin', 'Teacher', 'Campus', 'System'], required: true },
  /** Authoritative event timestamp — not relying on Mongoose timestamps */
  performedAt: { type: Date, default: Date.now, index: true },

  // ── Change tracking (UPDATE actions only) ──────────────────────────────────
  /** Name of the top-level field that was modified */
  fieldChanged: { type: String, default: null },
  /** Previous field value — stored as Mixed to support all types */
  oldValue:     { type: mongoose.Schema.Types.Mixed, default: null },
  /** New field value */
  newValue:     { type: mongoose.Schema.Types.Mixed, default: null },

  /**
   * Justification required for sensitive operations:
   * UPDATE(PUBLISHED/LOCKED), RESTORE, VERSION_RESTORE, LOCK, UNLOCK, DELETE(soft)
   * Minimum 10 characters when required (enforced at service layer).
   */
  reason: { type: String, default: null, trim: true },

  // ── Context ────────────────────────────────────────────────────────────────
  ipAddress: { type: String, default: null },
  userAgent: { type: String, default: null },
  /** Flexible payload for action-specific context (e.g., share token ID, version number) */
  metadata:  { type: mongoose.Schema.Types.Mixed, default: null },

}, {
  timestamps: false,   // performedAt is the authoritative timestamp
  versionKey: false,   // No __v needed on an append-only collection
});

// ── Indexes ───────────────────────────────────────────────────────────────────

// Campus-level audit feed (most recent first)
DocumentAuditSchema.index({ campusId: 1, performedAt: -1 });
// Per-document audit feed
DocumentAuditSchema.index({ documentId: 1, performedAt: -1 });
// Filter by action type within a campus
DocumentAuditSchema.index({ campusId: 1, action: 1, performedAt: -1 });
// Per-user activity across campus
DocumentAuditSchema.index({ performedBy: 1, performedAt: -1 });

// ── Append-Only Enforcement ───────────────────────────────────────────────────

/**
 * These hooks prevent accidental or intentional deletion of audit records.
 * Audit integrity is non-negotiable for regulatory compliance.
 */
DocumentAuditSchema.pre('deleteOne', function () {
  throw new Error('DocumentAudit records are immutable — deletion is not permitted');
});

DocumentAuditSchema.pre('findOneAndDelete', function () {
  throw new Error('DocumentAudit records are immutable — deletion is not permitted');
});

DocumentAuditSchema.pre('deleteMany', function () {
  throw new Error('DocumentAudit records are immutable — deletion is not permitted');
});

// ── Statics ───────────────────────────────────────────────────────────────────

DocumentAuditSchema.statics.ACTION = AUDIT_ACTION;

const DocumentAudit = mongoose.model('DocumentAudit', DocumentAuditSchema);

module.exports = DocumentAudit;
module.exports.AUDIT_ACTION = AUDIT_ACTION;