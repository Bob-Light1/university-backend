'use strict';

/**
 * @file documentVersion.model.js
 * @description Full snapshots of a document at specific points in time.
 *
 * Design decisions:
 * - A version is created automatically before any update to a PUBLISHED document.
 * - Also created at publish time and after ADMIN unlock.
 * - campusId is mandatory for isolation — version queries never cross campus boundaries.
 * - PDF snapshot filename: {docRef}_v{version}_{this._id}.pdf
 *   The ObjectId suffix guarantees global uniqueness, making CDN caching perfectly safe.
 * - Hard-deleted only when the parent document is hard-deleted (ADMIN/DIRECTOR action).
 * - Soft-pruned at 50 versions for campus users (cron job, Phase 3).
 *
 * v1.3 changes:
 * - ContentBlockSchema now imported from document.subschemas.js instead of re-declared.
 */

const mongoose = require('mongoose');

const { ContentBlockSchema } = require('./document.subschemas');
const { DOCUMENT_STATUS }    = require('./document.model');

// ── Schema ────────────────────────────────────────────────────────────────────

const DocumentVersionSchema = new mongoose.Schema({
  /** Parent document reference */
  documentId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'Document',
    required: true,
  },
  /** Campus scope — mandatory for isolation */
  campusId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'Campus',
    required: true,
  },

  /** Monotonically increasing integer. Matches Document.currentVersion at snapshot time. */
  version:  { type: Number, required: true },
  title:    { type: String },
  body:     { type: [ContentBlockSchema], default: [] },
  status:   { type: String, enum: Object.values(DOCUMENT_STATUS) },
  /** Branding config snapshot — stored as Mixed to capture any future branding fields */
  branding: { type: mongoose.Schema.Types.Mixed },

  /**
   * PDF snapshot filename.
   * Format: {docRef}_v{version}_{this._id}.pdf
   * The _id portion ensures global uniqueness across all versions.
   */
  pdfSnapshot: { type: String, default: null },

  /**
   * Reason this snapshot was taken.
   * 'pre-publish'  → taken before a publish operation
   * 'pre-archive'  → taken before an archive operation
   * 'auto'         → taken automatically before any update to a PUBLISHED document
   * 'manual'       → triggered explicitly by an authorized user
   */
  snapshotReason: {
    type:    String,
    enum:    ['auto', 'manual', 'pre-publish', 'pre-archive'],
    default: 'auto',
  },

  takenBy: {
    userId:    { type: mongoose.Schema.Types.ObjectId },
    userModel: { type: String, enum: ['Admin', 'Teacher', 'Campus', 'System'] },
  },
  takenAt: { type: Date, default: Date.now },

}, { versionKey: false });

// ── Indexes ───────────────────────────────────────────────────────────────────

// Version history list (most recent first)
DocumentVersionSchema.index({ documentId: 1, version: -1 });
// Campus-scope isolation
DocumentVersionSchema.index({ campusId: 1 });

const DocumentVersion = mongoose.model('DocumentVersion', DocumentVersionSchema);

module.exports = DocumentVersion;