'use strict';

/**
 * @file document.storage.service.js
 * @description File storage abstraction layer for the document module.
 *
 * Two interchangeable backends behind one interface:
 *   `document.storage.local.js`       — local filesystem (development, or a mounted volume)
 *   `document.storage.cloudinary.js`  — object store (production default)
 *
 * The provider is resolved once at load from `resolveProvider()`; the boot
 * preflight (`shared/utils/storage-preflight.js`) refuses to start a production
 * process whose provider cannot survive a redeploy.
 *
 * Storage keys are provider-neutral and campus-scoped:
 *   `{campusId}/{category}/{fileName}`
 * Mongo keeps storing a bare `fileName` (`importedFile.fileName`, `pdfSnapshot`,
 * `qrCode.fileName`) and the category is implied by the call site, exactly as
 * before — which is why swapping the backend needs no schema migration.
 *
 * Security measures (unchanged, and all applied before the bytes reach a backend):
 *   - Storage filenames are UUID-based — original name never used in paths
 *   - Files are NEVER served as static assets — all access goes through authenticated
 *     API endpoints; the Cloudinary backend keeps that true by storing every object
 *     as `type: 'authenticated'` and reading it back through a short-lived signed URL
 *   - Magic byte validation is performed before saving (independent of file extension)
 *   - PDF files have embedded JavaScript stripped via pdf-lib before storage
 *   - Campus-scoped keys enforce logical isolation, and `buildKey` refuses any
 *     filename that is not a bare basename
 *
 * Categories:
 *   imported   — externally uploaded files
 *   generated  — server-generated files (HTML, etc.)
 *   logos      — campus branding logos
 *   images     — content block images
 *   qrcodes    — QR code PNGs (legacy: nothing writes these any more, see document.qr.service.js)
 *   pdf        — PDF snapshots
 */

const path     = require('path');
const crypto   = require('crypto');
const { PDFDocument } = require('pdf-lib');
const sharp    = require('sharp');

const {
  STORAGE_PROVIDER,
  resolveStorageProvider,
} = require('../../../shared/utils/storage-provider');

// ── Constants ─────────────────────────────────────────────────────────────────

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

// ── Provider resolution ───────────────────────────────────────────────────────

/**
 * Active backend, resolved once — the answer cannot change while the process runs.
 * The decision itself lives in `shared/utils/storage-provider.js` so the boot
 * preflight reaches the same conclusion from the same code (B8-①).
 *
 * Only the selected backend is loaded. Requiring both would pull the Cloudinary SDK
 * into every local-disk process (and vice versa) for no benefit — measured at ~0.5 s
 * of boot time, on top of `sharp` and `pdf-lib` which this file genuinely needs.
 */
const backend = resolveStorageProvider() === STORAGE_PROVIDER.CLOUDINARY
  ? require('./document.storage.cloudinary')
  : require('./document.storage.local');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Builds the provider-neutral storage key for a campus/category/file triple.
 *
 * Fails closed on anything that is not a bare filename. The stored names are UUIDs
 * and version-derived refs, but they travel through document content and request
 * bodies on the way back in, and a `..` segment here would address another campus's
 * objects on the local backend. Guarding at the single point where every key is
 * built is what makes that structurally impossible rather than a property of six
 * separate call sites.
 *
 * @param {string} campusId
 * @param {string} category
 * @param {string} fileName
 * @returns {string} `{campusId}/{category}/{fileName}`
 * @throws {Error} statusCode 400 on a missing campusId or an unsafe filename
 */
const buildKey = (campusId, category, fileName) => {
  // Guard: campusId must never be null/undefined at this point. If it is, the caller
  // (controller) failed to resolve the effective campusId before reaching the storage
  // layer — surface a clear error rather than writing outside any campus scope.
  if (campusId == null || campusId === '') {
    throw Object.assign(
      new Error('campusId is required to resolve the storage key'),
      { statusCode: 400 },
    );
  }
  if (!fileName || path.basename(fileName) !== fileName || fileName === '..') {
    throw Object.assign(
      new Error('Invalid storage filename'),
      { statusCode: 400 },
    );
  }
  const safeCampus = path.basename(String(campusId));
  return `${safeCampus}/${CATEGORIES[category] || category}/${fileName}`;
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

/** Extension → Content-Type for the download endpoint. */
const MIME_BY_EXTENSION = Object.freeze({
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
});

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Saves an uploaded file to campus-scoped storage.
 * Applies magic byte validation, PDF sanitization, and image optimization.
 *
 * @param {object} file       - { buffer: Buffer, mimetype: string, originalname: string, size: number }
 * @param {string} campusId
 * @param {string} category   - One of: imported, generated, logos, images, qrcodes, pdf
 * @returns {Promise<{ fileName: string, originalName: string, mimeType: string, sizeBytes: number, extension: string, key: string, provider: string }>}
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
  const extension = path.extname(originalname).toLowerCase().slice(1) || 'bin';
  const fileName  = `${crypto.randomUUID()}.${extension}`;
  const key       = buildKey(campusId, category, fileName);

  await backend.put(key, processedBuffer, { mimeType: mimetype });

  return {
    fileName,
    originalName: path.basename(originalname).slice(0, 255), // Sanitized for display only
    mimeType:     mimetype,
    sizeBytes:    processedBuffer.length,
    extension,
    key,
    provider:     backend.name,
  };
};

/**
 * Saves a server-generated buffer under a caller-chosen filename.
 *
 * Distinct from `saveFile` because the two have genuinely different rules, and
 * collapsing them would mean weakening one: `saveFile` handles operator-supplied
 * bytes, so it validates magic bytes, sanitises PDFs and assigns a UUID name;
 * this one handles bytes the server just produced, under a name the caller needs
 * to control (a PDF snapshot's filename encodes the document version, which is
 * what makes a cached PDF safe to serve).
 *
 * @param {Buffer} buffer
 * @param {{ campusId: string, category: string, fileName: string, mimeType?: string }} target
 * @returns {Promise<{ fileName: string, key: string, sizeBytes: number, provider: string }>}
 */
const saveBuffer = async (buffer, { campusId, category, fileName, mimeType }) => {
  const key = buildKey(campusId, category, fileName);
  await backend.put(key, buffer, { mimeType });
  return { fileName, key, sizeBytes: buffer.length, provider: backend.name };
};

/**
 * Reads a stored file into memory.
 *
 * `maxBytes` is enforced AFTER the transfer rather than through a metadata probe:
 * a probe doubles the round trips on the object store to protect against a case
 * the upload limits already bound. The oversized buffer is discarded, not returned.
 *
 * @param {string} campusId
 * @param {string} category
 * @param {string} fileName
 * @param {{ maxBytes?: number }} [options]
 * @returns {Promise<Buffer|null>} null when absent, unreadable, or over `maxBytes`.
 */
const readFile = async (campusId, category, fileName, options = {}) => {
  let key;
  try {
    key = buildKey(campusId, category, fileName);
  } catch {
    return null;
  }

  let buffer;
  try {
    buffer = await backend.get(key);
  } catch {
    return null;
  }
  if (!buffer) return null;

  if (options.maxBytes && buffer.length > options.maxBytes) {
    console.warn(`[Storage] ${key} skipped — ${buffer.length} bytes exceeds the caller's limit.`);
    return null;
  }

  return buffer;
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
    return await backend.remove(buildKey(campusId, category, fileName));
  } catch {
    return false;
  }
};

/**
 * Streams a file from campus-scoped storage to an Express response.
 * Sets appropriate Content-Type and Content-Disposition headers.
 *
 * Files are NEVER served as static assets — all access goes through this
 * authenticated method, on both backends.
 *
 * @param {string}                        campusId
 * @param {string}                        category
 * @param {string}                        fileName
 * @param {import('express').Response}    res
 * @param {{ download?: boolean, displayName?: string }} options
 */
const streamFile = async (campusId, category, fileName, res, options = {}) => {
  const key    = buildKey(campusId, category, fileName);
  const stream = await backend.openStream(key);

  if (!stream) {
    throw Object.assign(new Error('File not found'), { statusCode: 404 });
  }

  const ext         = path.extname(fileName).toLowerCase();
  const contentType = MIME_BY_EXTENSION[ext] || 'application/octet-stream';

  // Sanitize the display name before placing it in the Content-Disposition header:
  // strip quotes, backslashes and control chars to prevent header/response splitting.
  const rawName  = options.displayName || fileName;
  const safeName = String(rawName).replace(/[\r\n"\\]/g, '').slice(0, 255) || 'download';
  // SVG is served as a download (never inline) to avoid stored-XSS via embedded scripts.
  const forceDownload = options.download || contentType === 'image/svg+xml';
  const disposition   = forceDownload
    ? `attachment; filename="${safeName}"`
    : `inline; filename="${safeName}"`;

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', disposition);
  res.setHeader('Cache-Control', 'private, no-cache');
  // Prevent MIME sniffing — the declared Content-Type is authoritative.
  res.setHeader('X-Content-Type-Options', 'nosniff');

  stream.pipe(res);
};

module.exports = {
  saveFile,
  saveBuffer,
  readFile,
  deleteFile,
  streamFile,
  validateMagicBytes,
  buildKey,
  activeProvider: backend.name,
  CATEGORIES,
};
