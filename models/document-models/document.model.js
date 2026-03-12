'use strict';

/**
 * @file document.model.js
 * @description Core Mongoose model for all institutional documents.
 */

const mongoose = require('mongoose');

const {
  ContentBlockSchema,
  BrandingSchema,
  PrintConfigSchema,
} = require('./document.subschemas');

// ── Enumerations ──────────────────────────────────────────────────────────────

/**
 * Workflow states for a document.
 * LOCKED = Published + protected. Auto-set when shared externally or marked Official.
 * Only ADMIN/DIRECTOR can modify or unlock LOCKED documents.
 */
const DOCUMENT_STATUS = Object.freeze({
  DRAFT:     'DRAFT',
  PUBLISHED: 'PUBLISHED',
  ARCHIVED:  'ARCHIVED',
  LOCKED:    'LOCKED',
});

/**
 * All supported document types across the platform.
 * IMPORTED = external file with no rich-content body.
 */
const DOCUMENT_TYPE = Object.freeze({
  STUDENT_ID_CARD:    'STUDENT_ID_CARD',
  STUDENT_TRANSCRIPT: 'STUDENT_TRANSCRIPT',
  STUDENT_BADGE:      'STUDENT_BADGE',
  TEACHER_PAYSLIP:    'TEACHER_PAYSLIP',
  TEACHER_BADGE:      'TEACHER_BADGE',
  TEACHER_CONTRACT:   'TEACHER_CONTRACT',
  CLASS_LIST:         'CLASS_LIST',
  COURSE_MATERIAL:    'COURSE_MATERIAL',
  ADMINISTRATIVE:     'ADMINISTRATIVE',
  REPORT:             'REPORT',
  PARTNER_BADGE:      'PARTNER_BADGE',
  PARENT_BADGE:       'PARENT_BADGE',
  CUSTOM:             'CUSTOM',
  IMPORTED:           'IMPORTED',
});

/**
 * Document types restricted to ADMIN/DIRECTOR/CAMPUS_MANAGER.
 * TEACHER can never create or update these types regardless of other role checks.
 * Enforced independently in document.access.middleware.js (Layer B).
 */
const RESTRICTED_DOCUMENT_TYPES = Object.freeze([
  'STUDENT_ID_CARD',
  'STUDENT_TRANSCRIPT',
  'TEACHER_PAYSLIP',
  'TEACHER_CONTRACT',
  'TEACHER_BADGE',
  'STUDENT_BADGE',
  'PARTNER_BADGE',
  'PARENT_BADGE',
  'CLASS_LIST',
  'ADMINISTRATIVE',
  'REPORT',
  'CUSTOM',
]);

const DOCUMENT_CATEGORY = Object.freeze({
  ACADEMIC:       'ACADEMIC',
  ADMINISTRATIVE: 'ADMINISTRATIVE',
  FINANCIAL:      'FINANCIAL',
  IDENTITY:       'IDENTITY',
  COMMUNICATION:  'COMMUNICATION',
});

/**
 * Retention policy options.
 * Enforced by document.retention.cron.js on a weekly schedule.
 */
const RETENTION_POLICY = Object.freeze({
  PERMANENT:  'PERMANENT',
  TEN_YEARS:  '10_YEARS',
  FIVE_YEARS: '5_YEARS',
  ONE_YEAR:   '1_YEAR',
  CUSTOM:     'CUSTOM',
});

// ── LastAuditEntry (kept inline — only used by Document model) ────────────────

/**
 * Lightweight snapshot of the most recent audit event.
 * Used for quick "Last modified by X on Y" display without a collection join.
 * Full audit history is stored exclusively in the DocumentAudit collection.
 */
const LastAuditEntrySchema = new mongoose.Schema({
  action:      { type: String },
  performedBy: { type: mongoose.Schema.Types.ObjectId },
  userModel:   { type: String, enum: ['Admin', 'Teacher', 'Campus'] },
  performedAt: { type: Date },
  ipAddress:   { type: String },
}, { _id: false });

// ── Main Document Schema ──────────────────────────────────────────────────────

const DocumentSchema = new mongoose.Schema({

  // ── Identity ───────────────────────────────────────────────────────────────
  /**
   * Human-readable unique reference.
   * Format: DOC-{YEAR}-{CAMPUS_CODE}-{nanoid(8)}
   */
  ref: {
    type: String, required: true, uppercase: true, trim: true,
  },
  title:       { type: String, required: true, trim: true, minlength: 3, maxlength: 200 },
  /** Auto-generated from title + nanoid(4) at creation. Used in public-facing URLs. */
  slug:        { type: String, trim: true, lowercase: true },
  description: { type: String, maxlength: 500, default: '' },

  // ── Classification ─────────────────────────────────────────────────────────
  type:     { type: String, enum: Object.values(DOCUMENT_TYPE),     required: true },
  category: { type: String, enum: Object.values(DOCUMENT_CATEGORY), required: true },
  /** Lowercase, trimmed. Maximum 20 tags per document. */
  tags:     { type: [String], default: [] },

  // ── Campus Isolation (mandatory) ───────────────────────────────────────────
  /** Hard-wired campus scope. All queries MUST include campusId filter. */
  campusId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'Campus',
    required: true,
  },

  // ── Ownership ──────────────────────────────────────────────────────────────
  createdBy: {
    userId:    { type: mongoose.Schema.Types.ObjectId, required: true },
    userModel: { type: String, enum: ['Admin', 'Teacher', 'Campus'], required: true },
  },
  lastModifiedBy: {
    userId:    { type: mongoose.Schema.Types.ObjectId },
    userModel: { type: String, enum: ['Admin', 'Teacher', 'Campus'] },
  },

  // ── Rich-Content Body (typed documents) ────────────────────────────────────
  /** Maximum 10,000 blocks per document. Validated per-type before any DB write. */
  body:    { type: [ContentBlockSchema], default: [] },
  /** Server-rendered HTML snapshot. Used for in-browser preview without PDF generation. */
  rawHtml: { type: String, default: null },
  /**
   * PDF snapshot filename.
   * Format: {docRef}_v{versionNumber}_{versionId}.pdf
   * versionId suffix ensures CDN/HTTP cache immutability — stale PDFs are never served.
   */
  pdfSnapshot: { type: String, default: null },

  // ── Imported File (IMPORTED type only) ────────────────────────────────────
  importedFile: {
    /** UUID-based storage filename — never exposed in URLs */
    fileName:     { type: String },
    /** Sanitized original filename — display only, never used as storage path */
    originalName: { type: String },
    mimeType:     { type: String },
    sizeBytes:    { type: Number },
    extension:    { type: String },
    uploadedAt:   { type: Date },
  },

  // ── Template Link ──────────────────────────────────────────────────────────
  templateId:   { type: mongoose.Schema.Types.ObjectId, ref: 'DocumentTemplate', default: null },
  /** Flat key-value map of variables injected into the template at generation time */
  templateData: { type: mongoose.Schema.Types.Mixed, default: null },

  // ── Entity Links ───────────────────────────────────────────────────────────
  /**
   * References to related entities (students, teachers, courses, etc.).
   * label is intentionally ABSENT — resolved at read time via .populate() to prevent stale data.
   */
  linkedEntities: [{
    entityType: {
      type: String,
      enum: ['Student', 'Teacher', 'Class', 'Course', 'Result', 'Campus'],
    },
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
    _id:      false,
  }],

  // ── Branding ───────────────────────────────────────────────────────────────
  branding: { type: BrandingSchema, default: () => ({}) },

  // ── QR Code ────────────────────────────────────────────────────────────────
  qrCode: {
    enabled:  { type: Boolean, default: false },
    /** Verification URL: https://{QR_VERIFICATION_BASE_URL}/verify/{doc.ref} */
    data:     { type: String },
    position: {
      type:    String,
      enum:    ['TOP_RIGHT', 'BOTTOM_RIGHT', 'BOTTOM_LEFT', 'TOP_LEFT'],
      default: 'BOTTOM_RIGHT',
    },
    size:        { type: Number, default: 80, min: 40, max: 200 },
    generatedAt: { type: Date },
    /** PNG filename stored under uploads/documents/{campusId}/qrcodes/ */
    fileName:    { type: String },
  },

  // ── Print & Export ─────────────────────────────────────────────────────────
  printConfig:   { type: PrintConfigSchema, default: () => ({}) },
  downloadCount: { type: Number, default: 0 },
  printCount:    { type: Number, default: 0 },

  // ── Status & Workflow ──────────────────────────────────────────────────────
  status:      { type: String, enum: Object.values(DOCUMENT_STATUS), default: 'DRAFT', index: true },
  publishedAt: { type: Date, default: null },
  archivedAt:  { type: Date, default: null },
  lockedAt:    { type: Date, default: null },
  /**
   * TTL field — MongoDB auto-expires and removes the document after this date.
   * Used for temporary generated documents (e.g., one-time exports).
   */
  expiresAt:   { type: Date, default: null },
  /**
   * Official documents auto-lock on first external share.
   * Once locked, modifications require ADMIN/DIRECTOR unlock + audit reason.
   */
  isOfficial:  { type: Boolean, default: false },
  /** Empty array = accessible by all campus roles. Populated to restrict access. */
  accessRoles: { type: [String], default: [] },

  // ── Soft Delete ────────────────────────────────────────────────────────────
  /** null = active document; set = soft-deleted. All queries filter deletedAt: null. */
  deletedAt: { type: Date, default: null },
  deletedBy: {
    userId:    { type: mongoose.Schema.Types.ObjectId, default: null },
    userModel: { type: String, default: null },
  },

  // ── Retention Policy (v1.2) ────────────────────────────────────────────────
  /**
   * Regulatory retention obligation. Applied automatically at creation by document.service.js.
   * Enforcement is performed by document.retention.cron.js (weekly soft-delete).
   *
   * Defaults by type:
   *   STUDENT_TRANSCRIPT, STUDENT_ID_CARD, TEACHER_CONTRACT → PERMANENT (null)
   *   TEACHER_PAYSLIP                                       → 10_YEARS
   *   REPORT, ADMINISTRATIVE, CLASS_LIST, COURSE_MATERIAL   → 5_YEARS
   *   IMPORTED                                              → 1_YEAR (configurable)
   *   CUSTOM                                                → PERMANENT (ADMIN-configurable)
   */
  retentionPolicy: {
    type:    String,
    enum:    Object.values(RETENTION_POLICY),
    default: 'PERMANENT',
  },
  /** null = permanent retention; set = auto-expire date for cron job */
  retentionUntil: { type: Date, default: null },

  // ── Structured Metadata (v1.2) ─────────────────────────────────────────────
  /**
   * Typed fields for efficient filtering — avoids full-text search for common queries.
   * Populated automatically based on document type at creation/generation.
   */
  metadata: {
    studentId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null },
    teacherId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', default: null },
    courseId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Course',  default: null },
    classId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Class',   default: null },
    semester:     { type: String, enum: ['S1', 'S2', 'Annual'],           default: null },
    academicYear: { type: String, trim: true,                             default: null },
    /** Month number (1–12) — primarily used for payslips */
    month:        { type: Number, min: 1, max: 12,                        default: null },
    year:         { type: Number,                                          default: null },
  },

  // ── Versioning ─────────────────────────────────────────────────────────────
  currentVersion: { type: Number, default: 1 },
  versionHistory: [{ type: mongoose.Schema.Types.ObjectId, ref: 'DocumentVersion' }],

  // ── Last Audit Entry ───────────────────────────────────────────────────────
  /** Single-object snapshot for quick display. Full history is in DocumentAudit. */
  lastAuditEntry: { type: LastAuditEntrySchema, default: null },

}, {
  timestamps: true,
  toJSON:     { virtuals: true },
  toObject:   { virtuals: true },
});

// ── Indexes ───────────────────────────────────────────────────────────────────

// Core campus-scoped query patterns
DocumentSchema.index({ campusId: 1, status: 1 });
DocumentSchema.index({ campusId: 1, type: 1 });
DocumentSchema.index({ campusId: 1, category: 1 });
DocumentSchema.index({ campusId: 1, tags: 1 });
DocumentSchema.index({ campusId: 1, createdAt: -1 });

// Unique identifiers
DocumentSchema.index({ ref: 1 }, { unique: true });
DocumentSchema.index({ slug: 1, campusId: 1 }, { unique: true, sparse: true });

// TTL auto-expiry for temporary documents
DocumentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Soft-delete filter
DocumentSchema.index({ deletedAt: 1 });

// Full-text search (Phase 1 — MongoDB $text; Phase 3 → Atlas Search)
DocumentSchema.index({ title: 'text', tags: 'text', description: 'text' });

// Entity link lookup (e.g., "all documents for student X")
DocumentSchema.index({ 'linkedEntities.entityId': 1 });

/**
 * Compound metadata indexes (v1.3) — the most frequent filtered list patterns.
 * Status is appended because list views almost always filter by status too.
 *   Ex: "all published docs for student X in campus Y"
 *       → campusId + metadata.studentId + status hits this index perfectly.
 */
DocumentSchema.index({ campusId: 1, 'metadata.studentId': 1, status: 1 });
DocumentSchema.index({ campusId: 1, 'metadata.teacherId': 1, status: 1 });
DocumentSchema.index({ campusId: 1, 'metadata.courseId':  1, status: 1 });
DocumentSchema.index({ campusId: 1, 'metadata.classId':   1, status: 1 });
DocumentSchema.index({ campusId: 1, 'metadata.academicYear': 1, 'metadata.semester': 1 });

// Ref-scoped index (public verification endpoint: /verify/:ref)
// sparse=true because `ref` is always set, but future partial refs may exist
DocumentSchema.index({ campusId: 1, ref: 1 });

// Retention cron job — finds documents past retentionUntil that are not yet deleted
DocumentSchema.index({ retentionUntil: 1, deletedAt: 1 });

// ── Static constants (accessible as Document.STATUS, Document.TYPE, etc.) ─────
DocumentSchema.statics.STATUS            = DOCUMENT_STATUS;
DocumentSchema.statics.TYPE              = DOCUMENT_TYPE;
DocumentSchema.statics.CATEGORY         = DOCUMENT_CATEGORY;
DocumentSchema.statics.RESTRICTED_TYPES = RESTRICTED_DOCUMENT_TYPES;
DocumentSchema.statics.RETENTION        = RETENTION_POLICY;

const Document = mongoose.model('Document', DocumentSchema);

module.exports = Document;
module.exports.DOCUMENT_STATUS           = DOCUMENT_STATUS;
module.exports.DOCUMENT_TYPE             = DOCUMENT_TYPE;
module.exports.DOCUMENT_CATEGORY         = DOCUMENT_CATEGORY;
module.exports.RESTRICTED_DOCUMENT_TYPES = RESTRICTED_DOCUMENT_TYPES;
module.exports.RETENTION_POLICY          = RETENTION_POLICY;