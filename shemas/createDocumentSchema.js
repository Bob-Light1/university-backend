'use strict';

/**
 * @file createDocument.schema.js
 * @description Yup validation schema for document creation.
 * Consistent with the platform's existing Yup-based validation pattern.
 *
 * Used by the validation middleware before createDocument controller is called.
 * ContentBlock discriminated validation is handled separately in
 * document.validation.service.js (called at service layer, not here).
 */

const Yup = require('yup');

const { DOCUMENT_TYPE, DOCUMENT_CATEGORY, RETENTION_POLICY } = require('../models/document.model');

// ── ContentBlock schema (structural check only — per-type validation is at service layer) ──

const contentBlockSchema = Yup.object({
  blockId: Yup.string().required('blockId is required'),
  type: Yup.string()
    .oneOf([
      'HEADING', 'PARAGRAPH', 'IMAGE', 'TABLE', 'LIST',
      'CODE_BLOCK', 'DIVIDER', 'QR_CODE', 'SIGNATURE_PLACEHOLDER',
    ])
    .required('Block type is required'),
  order:   Yup.number().integer().min(0).required('Block order is required'),
  content: Yup.mixed(),
  style:   Yup.mixed(),
});

// ── LinkedEntity schema ──

const linkedEntitySchema = Yup.object({
  entityType: Yup.string()
    .oneOf(['Student', 'Teacher', 'Class', 'Course', 'Result', 'Campus'])
    .required(),
  entityId: Yup.string().required('entityId is required'),
});

// ── Branding schema ──

const brandingSchema = Yup.object({
  logoFileName:   Yup.string().nullable(),
  primaryColor:   Yup.string().matches(/^#[0-9A-Fa-f]{6}$/, 'Invalid hex color').nullable(),
  accentColor:    Yup.string().matches(/^#[0-9A-Fa-f]{6}$/, 'Invalid hex color').nullable(),
  showCampusName: Yup.boolean(),
  showDate:       Yup.boolean(),
  footerText:     Yup.string().max(200).nullable(),
  headerText:     Yup.string().max(200).nullable(),
  watermark:      Yup.string().nullable(),
});

// ── PrintConfig schema ──

const printConfigSchema = Yup.object({
  pageSize:    Yup.string().oneOf(['A4', 'LETTER', 'A5', 'CARD_CR80', 'CUSTOM']),
  orientation: Yup.string().oneOf(['PORTRAIT', 'LANDSCAPE']),
  margins: Yup.object({
    top:    Yup.number().min(0).max(100),
    right:  Yup.number().min(0).max(100),
    bottom: Yup.number().min(0).max(100),
    left:   Yup.number().min(0).max(100),
  }),
  copies: Yup.number().integer().min(1).max(100),
});

// ── Metadata schema ──

const metadataSchema = Yup.object({
  studentId:    Yup.string().nullable(),
  teacherId:    Yup.string().nullable(),
  courseId:     Yup.string().nullable(),
  classId:      Yup.string().nullable(),
  semester:     Yup.string().oneOf(['S1', 'S2', 'Annual']).nullable(),
  academicYear: Yup.string().max(20).nullable(),
  month:        Yup.number().integer().min(1).max(12).nullable(),
  year:         Yup.number().integer().min(2000).max(2100).nullable(),
});

// ── Main create schema ────────────────────────────────────────────────────────

const createDocumentSchema = Yup.object({
  title:       Yup.string().trim().min(3).max(200).required('Title is required'),
  description: Yup.string().max(500),
  type: Yup.string()
    .oneOf(Object.values(DOCUMENT_TYPE), 'Invalid document type')
    .required('Document type is required'),
  category: Yup.string()
    .oneOf(Object.values(DOCUMENT_CATEGORY), 'Invalid document category')
    .required('Document category is required'),
  tags: Yup.array()
    .of(Yup.string().trim().lowercase().max(50))
    .max(20, 'Maximum 20 tags per document'),

  /** body is optional on creation — IMPORTED type won't have rich content */
  body: Yup.array()
    .of(contentBlockSchema)
    .max(10000, 'Document body cannot exceed 10,000 blocks'),

  linkedEntities: Yup.array().of(linkedEntitySchema).max(50),
  templateId:     Yup.string().nullable(),
  templateData:   Yup.mixed().nullable(),

  branding:    brandingSchema.default(undefined),
  printConfig: printConfigSchema.default(undefined),
  metadata:    metadataSchema.default(undefined),

  isOfficial:  Yup.boolean(),
  accessRoles: Yup.array().of(Yup.string()).max(10),

  expiresAt: Yup.date().min(new Date(), 'expiresAt must be a future date').nullable(),

  // Retention — only ADMIN/DIRECTOR can override defaults; validated at service layer
  retentionPolicy: Yup.string().oneOf(Object.values(RETENTION_POLICY)).nullable(),
  retentionUntil:  Yup.date().nullable(),
});

module.exports = { createDocumentSchema };