'use strict';

/**
 * @file document.validation.service.js
 * @description Discriminated per-type validation for ContentBlock content fields.
 *
 * Each block type has a strict validation schema. This service is called by
 * document.service.js before any DB write to ensure data integrity.
 *
 * HTML content in PARAGRAPH blocks is sanitized using sanitize-html to prevent XSS.
 * The whitelist permits basic formatting tags only — no <script>, <iframe>, on* handlers.
 *
 * Validation approach: custom lightweight validator (no Joi dependency added).
 * Throws a descriptive Error on validation failure — caught by asyncHandler in controllers.
 */

const sanitizeHtml = require('sanitize-html');
const { v4: uuidv4 } = require('uuid');

// ── sanitize-html whitelist ────────────────────────────────────────────────────

const HTML_SANITIZE_OPTIONS = {
  allowedTags: ['b', 'i', 'em', 'strong', 'u', 'br', 'p', 'span', 'a'],
  allowedAttributes: {
    a:    ['href', 'title'],
    span: ['style'],
  },
  allowedStyles: {
    span: {
      color:       [/^#[0-9A-Fa-f]{6}$/],
      'font-size': [/^\d+(px|em|rem)$/],
    },
  },
  disallowedTagsMode: 'discard',
};

// ── Validation Schemas ────────────────────────────────────────────────────────

/**
 * Per-type content validation rules.
 * Each entry maps a block type to its validation function.
 * Throws on failure, returns void on success.
 */
const BLOCK_VALIDATORS = {

  HEADING: (content, blockId) => {
    if (!content || typeof content !== 'object') {
      throw new Error(`Block ${blockId} (HEADING): content must be an object`);
    }
    if (!content.text || typeof content.text !== 'string') {
      throw new Error(`Block ${blockId} (HEADING): text is required`);
    }
    if (content.text.length > 500) {
      throw new Error(`Block ${blockId} (HEADING): text exceeds 500 characters`);
    }
    if (![1, 2, 3].includes(content.level)) {
      throw new Error(`Block ${blockId} (HEADING): level must be 1, 2, or 3`);
    }
    if (content.align && !['left', 'center', 'right'].includes(content.align)) {
      throw new Error(`Block ${blockId} (HEADING): invalid align value`);
    }
  },

  PARAGRAPH: (content, blockId) => {
    if (!content || typeof content !== 'object') {
      throw new Error(`Block ${blockId} (PARAGRAPH): content must be an object`);
    }
    if (!content.text || typeof content.text !== 'string') {
      throw new Error(`Block ${blockId} (PARAGRAPH): text is required`);
    }
    if (content.text.length > 10000) {
      throw new Error(`Block ${blockId} (PARAGRAPH): text exceeds 10,000 characters`);
    }
    if (content.align && !['left', 'center', 'right', 'justify'].includes(content.align)) {
      throw new Error(`Block ${blockId} (PARAGRAPH): invalid align value`);
    }
    if (content.color && !/^#[0-9A-Fa-f]{6}$/.test(content.color)) {
      throw new Error(`Block ${blockId} (PARAGRAPH): color must be a valid hex color (#RRGGBB)`);
    }
    if (content.fontSize !== undefined && (content.fontSize < 8 || content.fontSize > 72)) {
      throw new Error(`Block ${blockId} (PARAGRAPH): fontSize must be between 8 and 72`);
    }
    // Sanitize HTML in text field to prevent XSS
    content.text = sanitizeHtml(content.text, HTML_SANITIZE_OPTIONS);
  },

  IMAGE: (content, blockId) => {
    if (!content || typeof content !== 'object') {
      throw new Error(`Block ${blockId} (IMAGE): content must be an object`);
    }
    if (!content.fileName || typeof content.fileName !== 'string') {
      throw new Error(`Block ${blockId} (IMAGE): fileName is required`);
    }
    if (content.alt && content.alt.length > 200) {
      throw new Error(`Block ${blockId} (IMAGE): alt text exceeds 200 characters`);
    }
    if (content.width !== undefined && (content.width < 10 || content.width > 2000)) {
      throw new Error(`Block ${blockId} (IMAGE): width must be between 10 and 2000`);
    }
    if (content.caption && content.caption.length > 200) {
      throw new Error(`Block ${blockId} (IMAGE): caption exceeds 200 characters`);
    }
  },

  TABLE: (content, blockId) => {
    if (!content || typeof content !== 'object') {
      throw new Error(`Block ${blockId} (TABLE): content must be an object`);
    }
    if (!Array.isArray(content.headers) || content.headers.length === 0) {
      throw new Error(`Block ${blockId} (TABLE): headers array is required`);
    }
    if (content.headers.length > 20) {
      throw new Error(`Block ${blockId} (TABLE): headers cannot exceed 20 columns`);
    }
    if (!Array.isArray(content.rows)) {
      throw new Error(`Block ${blockId} (TABLE): rows must be an array`);
    }
    if (content.rows.length > 500) {
      throw new Error(`Block ${blockId} (TABLE): rows cannot exceed 500`);
    }
    // Validate row structure
    for (let i = 0; i < content.rows.length; i++) {
      if (!Array.isArray(content.rows[i])) {
        throw new Error(`Block ${blockId} (TABLE): row[${i}] must be an array`);
      }
    }
  },

  LIST: (content, blockId) => {
    if (!content || typeof content !== 'object') {
      throw new Error(`Block ${blockId} (LIST): content must be an object`);
    }
    if (!Array.isArray(content.items) || content.items.length === 0) {
      throw new Error(`Block ${blockId} (LIST): items array is required`);
    }
    if (content.items.length > 200) {
      throw new Error(`Block ${blockId} (LIST): items cannot exceed 200`);
    }
    if (!content.items.every((item) => typeof item === 'string')) {
      throw new Error(`Block ${blockId} (LIST): all items must be strings`);
    }
  },

  QR_CODE: (content, blockId) => {
    if (!content || typeof content !== 'object') {
      throw new Error(`Block ${blockId} (QR_CODE): content must be an object`);
    }
    if (!content.data || typeof content.data !== 'string') {
      throw new Error(`Block ${blockId} (QR_CODE): data is required`);
    }
    if (content.data.length > 2000) {
      throw new Error(`Block ${blockId} (QR_CODE): data exceeds 2000 characters`);
    }
    if (content.size !== undefined && (content.size < 40 || content.size > 200)) {
      throw new Error(`Block ${blockId} (QR_CODE): size must be between 40 and 200`);
    }
    if (content.label && content.label.length > 100) {
      throw new Error(`Block ${blockId} (QR_CODE): label exceeds 100 characters`);
    }
  },

  CODE_BLOCK: (content, blockId) => {
    if (!content || typeof content !== 'object') {
      throw new Error(`Block ${blockId} (CODE_BLOCK): content must be an object`);
    }
    if (!content.code || typeof content.code !== 'string') {
      throw new Error(`Block ${blockId} (CODE_BLOCK): code is required`);
    }
    if (content.code.length > 50000) {
      throw new Error(`Block ${blockId} (CODE_BLOCK): code exceeds 50,000 characters`);
    }
    if (content.language && content.language.length > 30) {
      throw new Error(`Block ${blockId} (CODE_BLOCK): language exceeds 30 characters`);
    }
  },

  DIVIDER: () => {
    // No content validation required for dividers
  },

  SIGNATURE_PLACEHOLDER: (content, blockId) => {
    if (content && content.label && content.label.length > 100) {
      throw new Error(`Block ${blockId} (SIGNATURE_PLACEHOLDER): label exceeds 100 characters`);
    }
  },
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validates all content blocks in a document body using discriminated per-type schemas.
 * Mutates PARAGRAPH blocks to sanitize HTML content in place.
 *
 * Throws a descriptive Error on the first validation failure.
 * Called by document.service.js before any DB write.
 *
 * @param {object[]} blocks - Array of ContentBlock objects
 * @throws {Error} On validation failure
 */
const validateContentBlocks = (blocks) => {
  if (!Array.isArray(blocks)) {
    throw new Error('Document body must be an array of content blocks');
  }

  if (blocks.length > 10000) {
    throw new Error('Document body cannot exceed 10,000 blocks');
  }

  for (const block of blocks) {
    // Ensure blockId exists — generate if missing (for convenience)
    if (!block.blockId) {
      block.blockId = uuidv4();
    }

    if (typeof block.order !== 'number') {
      throw new Error(`Block ${block.blockId}: order must be a number`);
    }

    const validator = BLOCK_VALIDATORS[block.type];
    if (!validator) {
      throw new Error(`Block ${block.blockId}: unknown block type "${block.type}"`);
    }

    validator(block.content, block.blockId);
  }
};

/**
 * Validates template variables completeness against a templateData map.
 * Called by document.template.controller.js before generating a document.
 *
 * @param {object[]} variableDefs     - Template variable declarations (from DocumentTemplate.variables)
 * @param {object}   templateData     - Caller-supplied values (flat key-value map)
 * @throws {Error} If required variables are missing
 */
const validateTemplateData = (variableDefs, templateData = {}) => {
  const missing = variableDefs
    .filter((v) => v.required && (templateData[v.key] === undefined || templateData[v.key] === null))
    .map((v) => v.key);

  if (missing.length > 0) {
    throw Object.assign(
      new Error(`Missing required template variables: ${missing.join(', ')}`),
      { statusCode: 400, fields: missing },
    );
  }
};

module.exports = {
  validateContentBlocks,
  validateTemplateData,
  HTML_SANITIZE_OPTIONS,
};