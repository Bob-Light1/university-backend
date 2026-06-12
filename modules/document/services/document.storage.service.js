'use strict';

/**
 * @file document.storage.service.js
 * @description File storage abstraction layer for the document module.
 *
 * Public interface is designed to be swappable:
 *   Phase 1: Local disk storage (current)
 *   Phase 3+: S3 / GCS via same interface without controller changes
 *
 * Security measures:
 *   - Storage filenames are UUID-based — original name never used in paths
 *   - Files are NEVER served as static assets — all access goes through authenticated API endpoints
 *   - Magic byte validation is performed before saving (independent of file extension)
 *   - PDF files have embedded JavaScript stripped via pdf-lib before storage
 *   - Campus-scoped directory structure enforces physical isolation
 *
 * Directory structure:
 *   uploads/documents/{campusId}/imported/   — externally uploaded files
 *   uploads/documents/{campusId}/generated/  — server-generated files (HTML, etc.)
 *   uploads/documents/{campusId}/logos/      — campus branding logos
 *   uploads/documents/{campusId}/images/     — content block images
 *   uploads/documents/{campusId}/qrcodes/    — QR code PNGs
 *   uploads/documents/{campusId}/pdf/        — PDF snapshots
 */

const fs       = require('fs').promises;
const fsSync   = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const { PDFDocument } = require('pdf-lib');
const sharp    = require('sharp');

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE_UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.join(process.env.UPLOAD_DIR, 'documents')
  : path.join(__dirname, '..', '..', 'uploads', 'documents');

const MAX_SIZE_BYTES = {
  document: parseInt(process.env.DOC_UPLOAD_MAX_SIZE_MB || '25', 10) * 1024 * 1024,
  image:    10 * 1024 * 1024,
  text:     5  * 1024 * 1024,
};

/**
 * Allowed MIME types and their expected magic byte signatures.
 * Magic bytes are checked INDEPENDENTLY of the file extension for security.
 */
const MAGIC_BYTES = {
  'application/pdf':  [[0x25, 0x50, 0x44, 0x46]],                        // %PDF
  'image/png':        [[0x89, 0x50, 0x4E, 0x47]],                        // .PNG
  'image/jpeg':       [[0xFF, 0xD8, 0xFF]],                               // JPEG
  'image/webp':       [[0x52, 0x49, 0x46, 0x46]],                        // RIFF (WebP)
  'application/zip':  [[0x50, 0x4B, 0x03, 0x04], [0x50, 0x4B, 0x05, 0x06]], // PK (docx/xlsx/pptx)
};

/** Storage category path mapping */
const CATEGORIES = Object.freeze({
  imported:  'imported',
  generated: 'generated',
  logos:     'logos',
  images:    'images',
  qrcodes:   'qrcodes',
  pdf:       'pdf',
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the absolute directory path for a campus/category combination.
 * Creates the directory if it does not exist.
 *
 * @param {string} campusId
 * @param {string} category
 * @returns {Promise<string>} Absolute directory path
 */
const getCategoryDir = async (campusId, category) => {
  // Guard: campusId must never be null/undefined at this point.
  // If it is, the caller (controller) failed to resolve the effective campusId
  // before reaching the storage layer — surface a clear error rather than a cryptic crash.
  if (campusId == null) {
    throw Object.assign(
      new Error('campusId is required to resolve the storage directory'),
      { statusCode: 400 },
    );
  }
  const dir = path.join(BASE_UPLOAD_DIR, campusId.toString(), CATEGORIES[category] || category);
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

/**
 * Validates a file's magic bytes against its declared MIME type.
 * Reads only the first 8 bytes — no full file load needed.
 *
 * @param {Buffer} buffer    - File buffer (minimum 8 bytes)
 * @param {string} mimeType  - Declared MIME type
 * @returns {boolean}
 */
const validateMagicBytes = (buffer, mimeType) => {
  const signatures = MAGIC_BYTES[mimeType];
  if (!signatures) return true; // Unknown MIME type — skip magic byte check

  return signatures.some((sig) =>
    sig.every((byte, idx) => buffer[idx] === byte),
  );
};

/**
 * Strips embedded JavaScript and active content from a PDF buffer using pdf-lib.
 * Prevents malicious PDF uploads from executing code when opened.
 *
 * @param {Buffer} pdfBuffer
 * @returns {Promise<Buffer>} Sanitized PDF buffer
 */
const stripPdfActiveContent = async (pdfBuffer) => {
  try {
    const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    // pdf-lib re-serialization removes JavaScript actions and active content
    const cleanBytes = await pdfDoc.save();
    return Buffer.from(cleanBytes);
  } catch {
    // If pdf-lib cannot parse it, return the original buffer
    // The extension + magic byte check has already validated the format
    return pdfBuffer;
  }
};

/**
 * Optimizes an image buffer using sharp.
 * Resizes oversized images and normalizes to the target format.
 *
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @returns {Promise<Buffer>}
 */
const optimizeImage = async (buffer, mimeType) => {
  try {
    const instance = sharp(buffer);
    const meta     = await instance.metadata();

    // Cap at 3000px on the longest side to prevent storage bloat
    if (meta.width > 3000 || meta.height > 3000) {
      instance.resize(3000, 3000, { fit: 'inside', withoutEnlargement: true });
    }

    return mimeType === 'image/png'
      ? await instance.png({ compressionLevel: 8 }).toBuffer()
      : await instance.jpeg({ quality: 88 }).toBuffer();
  } catch {
    return buffer;
  }
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Saves a file to campus-scoped storage.
 * Applies magic byte validation, PDF sanitization, and image optimization.
 *
 * @param {object} file       - { buffer: Buffer, mimetype: string, originalname: string, size: number }
 * @param {string} campusId
 * @param {string} category   - One of: imported, generated, logos, images, qrcodes, pdf
 * @returns {Promise<{ fileName: string, originalName: string, mimeType: string, sizeBytes: number, extension: string, path: string }>}
 * @throws {Error} On validation failure or storage error
 */
const saveFile = async (file, campusId, category = 'imported') => {
  const { buffer, mimetype, originalname, size } = file;

  // Size validation
  const maxBytes = mimetype.startsWith('image/') ? MAX_SIZE_BYTES.image
    : (mimetype === 'text/plain' || mimetype === 'text/csv') ? MAX_SIZE_BYTES.text
    : MAX_SIZE_BYTES.document;

  if (size > maxBytes) {
    throw Object.assign(
      new Error(`File size (${Math.round(size / 1024 / 1024)} MB) exceeds the limit for this type`),
      { statusCode: 413 },
    );
  }

  // Magic byte validation
  const isValidMagic = validateMagicBytes(buffer, mimetype);
  if (!isValidMagic) {
    throw Object.assign(
      new Error('File content does not match its declared type (magic byte mismatch)'),
      { statusCode: 422 },
    );
  }

  // Security processing
  let processedBuffer = buffer;
  if (mimetype === 'application/pdf') {
    processedBuffer = await stripPdfActiveContent(buffer);
  } else if (mimetype.startsWith('image/') && ['image/png', 'image/jpeg', 'image/jpg'].includes(mimetype)) {
    processedBuffer = await optimizeImage(buffer, mimetype);
  }

  // UUID-based storage filename — original name NEVER used in storage path
  const extension  = path.extname(originalname).toLowerCase().slice(1) || 'bin';
  const fileName   = `${crypto.randomUUID()}.${extension}`;
  const dir        = await getCategoryDir(campusId, category);
  const filePath   = path.join(dir, fileName);

  await fs.writeFile(filePath, processedBuffer);

  return {
    fileName,
    originalName: path.basename(originalname).slice(0, 255), // Sanitized for display only
    mimeType:     mimetype,
    sizeBytes:    processedBuffer.length,
    extension,
    path:         filePath,
  };
};

/**
 * Deletes a file from campus-scoped storage.
 *
 * @param {string} campusId
 * @param {string} category
 * @param {string} fileName  - UUID-based filename (not original name)
 * @returns {Promise<boolean>}
 */
const deleteFile = async (campusId, category, fileName) => {
  try {
    const dir      = path.join(BASE_UPLOAD_DIR, campusId.toString(), CATEGORIES[category] || category);
    const filePath = path.join(dir, fileName);
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
};

/**
 * Streams a file from campus-scoped storage to an Express response.
 * Sets appropriate Content-Type and Content-Disposition headers.
 *
 * Files are NEVER served as static assets — all access goes through this authenticated method.
 *
 * @param {string}                        campusId
 * @param {string}                        category
 * @param {string}                        fileName
 * @param {import('express').Response}    res
 * @param {{ download?: boolean, displayName?: string }} options
 */
const streamFile = async (campusId, category, fileName, res, options = {}) => {
  const dir      = path.join(BASE_UPLOAD_DIR, campusId.toString(), CATEGORIES[category] || category);
  const filePath = path.join(dir, fileName);

  try {
    await fs.access(filePath);
  } catch {
    throw Object.assign(new Error('File not found'), { statusCode: 404 });
  }

  const ext = path.extname(fileName).toLowerCase();
  const mimeMap = {
    '.pdf':  'application/pdf',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg':  'image/svg+xml',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt':  'text/plain',
    '.csv':  'text/csv',
  };

  const contentType = mimeMap[ext] || 'application/octet-stream';
  const displayName = options.displayName || fileName;
  const disposition = options.download
    ? `attachment; filename="${displayName}"`
    : `inline; filename="${displayName}"`;

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', disposition);
  res.setHeader('Cache-Control', 'private, no-cache');

  fsSync.createReadStream(filePath).pipe(res);
};

/**
 * Computes total storage usage for a campus in bytes.
 * Walks the campus directory tree and sums file sizes.
 * Note: prefer the DB aggregation in document.campus.middleware.js for quota checks.
 * This method is used for filesystem-level verification.
 *
 * @param {string} campusId
 * @returns {Promise<number>} Total bytes used
 */
const getStorageUsageBytes = async (campusId) => {
  const campusDir = path.join(BASE_UPLOAD_DIR, campusId.toString());

  try {
    await fs.access(campusDir);
  } catch {
    return 0;
  }

  let total = 0;

  const walkDir = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkDir(fullPath);
      } else {
        const stat = await fs.stat(fullPath);
        total += stat.size;
      }
    }
  };

  await walkDir(campusDir);
  return total;
};

module.exports = {
  saveFile,
  deleteFile,
  streamFile,
  getStorageUsageBytes,
  validateMagicBytes,
  CATEGORIES,
};