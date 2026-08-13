'use strict';

/**
 * @file deletion-audit.model.js
 * @description Append-only ledger of every permanent-deletion attempt in the platform.
 *
 * A hard delete is the one operation the application cannot undo. This collection is the
 * only trace that survives it, so it is deliberately:
 *
 *  - **append-only** — delete hooks throw, exactly like DocumentAudit. The ledger outlives
 *    the campus, the actor and the entity it describes.
 *  - **written for refusals too** — a BLOCKED attempt is precisely what a post-incident
 *    review needs to see. Outcome is a first-class field, not an inference.
 *  - **self-sufficient** — it stores a redacted snapshot of the deleted document, so the row
 *    still means something once every referenced id is gone.
 *
 * It carries no soft-delete marker on purpose (CLAUDE.md §5.1: audit records are never
 * deleted), and no TTL index.
 */

const mongoose = require('mongoose');
const { DELETION_OUTCOME, RELATION_MODE } = require('./hard-delete.constants');

/** One line of the impact report, as computed at execution time. */
const ImpactLineSchema = new mongoose.Schema(
  {
    /** Related model name, e.g. 'Result'. */
    model: { type: String, required: true },
    /** Human-readable label shown in the danger-zone dialog. */
    label: { type: String, required: true },
    /** How the relation was handled. */
    mode:  { type: String, enum: Object.values(RELATION_MODE), required: true },
    /** Number of matching documents at the moment of the operation. */
    count: { type: Number, required: true, min: 0 },
    /** True when `count` hit IMPACT_COUNT_LIMIT — the real figure is "at least" this. */
    capped: { type: Boolean, default: false },
  },
  { _id: false },
);

const DeletionAuditSchema = new mongoose.Schema(
  {
    // ── Target ────────────────────────────────────────────────────────────────
    /** Registry key of the deleted entity, e.g. 'student'. */
    entityType:  { type: String, required: true, index: true },
    /** Mongoose model name backing that key, e.g. 'Student'. */
    entityModel: { type: String, required: true },
    /** Id of the target. Kept as an ObjectId for cross-referencing, never as a ref. */
    entityId:    { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    /** Business key the operator had to type, e.g. 'STU-2024-0031'. */
    entityIdentifier: { type: String, required: true, trim: true },
    /** Display label at deletion time, e.g. 'Jane Doe'. */
    entityLabel: { type: String, required: true, trim: true, maxlength: 200 },
    /** Campus the entity belonged to; null for global collections. */
    campusId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Campus', default: null, index: true },

    // ── Actor ─────────────────────────────────────────────────────────────────
    performedBy:      { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    performedByModel: { type: String, required: true },
    performedByRole:  { type: String, required: true },
    performedAt:      { type: Date, required: true, default: Date.now, index: true },

    // ── Justification & proof of intent ───────────────────────────────────────
    /** Mandatory free-text justification supplied by the operator. */
    reason: { type: String, required: true, trim: true, maxlength: 600 },
    /** The exact phrase typed by the operator, stored verbatim for the record. */
    confirmationPhrase: { type: String, required: true, trim: true, maxlength: 200 },
    /**
     * Digest of the impact report the operator approved. Proves the ticket that authorized
     * this deletion was issued for this exact state of the database.
     */
    impactDigest: { type: String, required: true },
    /** True when the actor re-entered their password successfully. Always true on success. */
    passwordVerified: { type: Boolean, required: true, default: false },

    // ── What actually happened ────────────────────────────────────────────────
    outcome: {
      type:     String,
      enum:     Object.values(DELETION_OUTCOME),
      required: true,
      index:    true,
    },
    /** Populated when outcome is BLOCKED or FAILED. */
    failureReason: { type: String, default: null, trim: true, maxlength: 500 },
    /** Impact report as computed server-side at execution time. */
    impact: { type: [ImpactLineSchema], default: [] },
    /** Number of documents actually removed per model, e.g. { StudentAttendance: 42 }. */
    cascadeDeleted: { type: mongoose.Schema.Types.Mixed, default: {} },
    /** Number of documents whose reference was unset per model. */
    detached: { type: mongoose.Schema.Types.Mixed, default: {} },
    /** Stored files removed alongside the document (profile images, uploads). */
    filesRemoved: { type: [String], default: [] },

    /**
     * Redacted copy of the deleted document — credentials and tokens stripped.
     * The only reconstruction material left once the row is gone.
     */
    snapshot: { type: mongoose.Schema.Types.Mixed, default: null },

    // ── Request context ───────────────────────────────────────────────────────
    ipAddress: { type: String, default: null },
    userAgent: { type: String, default: null },
  },
  { timestamps: true, collection: 'deletion_audits' },
);

// Chronological feed per campus — the danger-zone history screen.
DeletionAuditSchema.index({ campusId: 1, performedAt: -1 });
// Per-entity-type feed, used by the per-module history endpoints.
DeletionAuditSchema.index({ entityType: 1, performedAt: -1 });

// ── Append-Only Enforcement ───────────────────────────────────────────────────

/**
 * Deletion of an audit row is never legitimate: it is the sole surviving trace of an
 * irreversible operation. These hooks fail loudly rather than silently allowing a purge.
 */
const refuseDeletion = function () {
  throw new Error('DeletionAudit records are immutable — deletion is not permitted');
};

// `deleteOne` is registered for BOTH middleware kinds: Mongoose treats
// `Model.deleteOne()` (query) and `doc.deleteOne()` (document) as separate hooks, and
// leaving either one open would leave a way to purge the ledger.
DeletionAuditSchema.pre('deleteOne', { document: true, query: true }, refuseDeletion);
DeletionAuditSchema.pre('deleteMany', refuseDeletion);
DeletionAuditSchema.pre('findOneAndDelete', refuseDeletion);

const DeletionAudit = mongoose.model('DeletionAudit', DeletionAuditSchema);

module.exports = DeletionAudit;
