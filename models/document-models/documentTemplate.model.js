'use strict';

/**
 * @file documentTemplate.model.js
 * @description Reusable layout templates for typed document generation.
 *
 * Design decisions:
 * - campusId = null → global template, accessible by all campuses (ADMIN/DIRECTOR only).
 * - campusId = ObjectId → campus-specific template, isolated to that campus.
 * - Layout uses the same ContentBlock structure as Document.body (shared sub-schema).
 * - Variables declare injectable placeholders ({{key}}) resolved at generation time.
 * - usageCount + lastUsedAt enable popularity ranking and template analytics (v1.3).
 */

const mongoose = require('mongoose');

const {
  ContentBlockSchema,
  BrandingSchema,
  PrintConfigSchema,
} = require('./document.subschemas');

const { DOCUMENT_TYPE } = require('./document.model');

// ── TemplateVariable ──────────────────────────────────────────────────────────

/**
 * Declares an injectable placeholder.
 * Key format: snake_case (e.g., 'student_name', 'campus_logo').
 * The generation service validates all required variables are present before proceeding.
 */
const TemplateVariableSchema = new mongoose.Schema({
  /** Placeholder key used in layout content: {{key}} */
  key:      { type: String, required: true, trim: true },
  /** Human-readable label shown in the generation form */
  label:    { type: String, required: true, trim: true },
  /** Expected value type — determines the input control shown in the frontend */
  type:     { type: String, enum: ['text', 'date', 'number', 'image', 'array'], default: 'text' },
  required: { type: Boolean, default: true },
}, { _id: false });

// ── Main Schema ───────────────────────────────────────────────────────────────

const DocumentTemplateSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true, minlength: 3, maxlength: 100 },
  description: { type: String, maxlength: 300, default: '' },
  /** Document type this template is designed to generate */
  type:        { type: String, enum: Object.values(DOCUMENT_TYPE), required: true },

  /**
   * null     → global template (all campuses, managed by ADMIN/DIRECTOR only)
   * ObjectId → campus-specific template (isolated to that campus)
   */
  campusId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campus', default: null, index: true },
  isGlobal: { type: Boolean, default: false },

  /** Template layout — same ContentBlock array structure as Document.body */
  layout: { type: [ContentBlockSchema], default: [] },

  /**
   * Declared variables that consumers must provide at generation time.
   * The generation service validates all required variables are present before proceeding.
   */
  variables: { type: [TemplateVariableSchema], default: [] },

  branding:    { type: BrandingSchema,    default: () => ({}) },
  printConfig: { type: PrintConfigSchema, default: () => ({}) },

  isActive:   { type: Boolean, default: true },
  /** Incremented each time this template is used to generate a document */
  usageCount: { type: Number, default: 0 },
  /** Set each time a document is generated from this template — enables sort-by-recent-use */
  lastUsedAt: { type: Date, default: null },

  createdBy: {
    userId:    { type: mongoose.Schema.Types.ObjectId },
    userModel: { type: String, enum: ['Admin', 'Teacher', 'Campus'] },
  },
  lastModifiedBy: {
    userId:    { type: mongoose.Schema.Types.ObjectId },
    userModel: { type: String, enum: ['Admin', 'Teacher', 'Campus'] },
  },

}, { timestamps: true });

// ── Indexes ───────────────────────────────────────────────────────────────────

// Campus-scoped template lookup
DocumentTemplateSchema.index({ campusId: 1, type: 1 });
// Global template lookup (list available for all campuses)
DocumentTemplateSchema.index({ isGlobal: 1, type: 1 });
// Active filter
DocumentTemplateSchema.index({ isActive: 1 });
// Popularity ranking — list templates sorted by most-used (admin analytics / smart defaults)
DocumentTemplateSchema.index({ usageCount: -1 });

const DocumentTemplate = mongoose.model('DocumentTemplate', DocumentTemplateSchema);

module.exports = DocumentTemplate;