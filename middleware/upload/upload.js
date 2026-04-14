'use strict';

/**
 * @file upload.js
 * @description Multer middleware — Cloudinary (production) / local disk (development).
 *
 * Strategy
 * ─────────────────────────────────────────────────────────────────────────────
 * • NODE_ENV=production → all persistent uploads go to Cloudinary.
 *   Render.com has an ephemeral filesystem: local files are wiped on every
 *   redeploy, so Cloudinary is the only safe store for images/PDFs.
 * • NODE_ENV=development → files land on local disk for fast iteration
 *   without consuming Cloudinary bandwidth.
 *
 * Two dedicated storages are provided:
 *   imageStorage   — JPEG/PNG/WEBP images (profiles, campus photos)
 *   documentStorage — PDF documents only
 *   csvMemoryStorage — CSV/Excel import files (always memory, never stored)
 *
 * CSV/Excel import files intentionally use multer.memoryStorage() in both
 * environments because they are parsed in-process and must never be written
 * to disk or Cloudinary.
 *
 * Exports (one name per responsibility — no ambiguous duplicates):
 *   uploadProfileImage   — single('profileImage')
 *   uploadCampusImage    — single('campus_image')
 *   uploadDocument       — single('document')  → PDF only
 *   handleMulterError    — Express error middleware
 *   cleanupUploadedFile  — Delete a local temp file on error (dev only)
 *   getFileUrl           — Build a public URL from a local Multer file object
 */

const multer   = require('multer');
const path     = require('path');
const fs       = require('fs').promises;
const crypto   = require('crypto');
const cloudinary           = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

// ── Environment ───────────────────────────────────────────────────────────────

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE    = 5  * 1024 * 1024; // 5 MB  — images
const MAX_PROFILE_SIZE = 2  * 1024 * 1024; // 2 MB  — profile images
const MAX_DOC_SIZE     = 10 * 1024 * 1024; // 10 MB — PDF documents

// Base upload directory used only in development
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');

// ── Cloudinary explicit configuration ────────────────────────────────────────
// The SDK auto-reads CLOUDINARY_URL when present, but explicit configuration
// is clearer, safer, and easier to audit in production.
cloudinary.config({
  cloud_name : process.env.CLOUDINARY_CLOUD_NAME,
  api_key    : process.env.CLOUDINARY_API_KEY,
  api_secret : process.env.CLOUDINARY_API_SECRET,
});

// ── Ensure local upload directories exist (dev only) ─────────────────────────

if (!IS_PRODUCTION) {
  const ensureLocalDirs = async () => {
    const dirs = [
      `${UPLOAD_DIR}/campuses`,
      `${UPLOAD_DIR}/students`,
      `${UPLOAD_DIR}/teachers`,
      `${UPLOAD_DIR}/parents`,
      `${UPLOAD_DIR}/documents`,
      `${UPLOAD_DIR}/temp`,
    ];
    for (const dir of dirs) {
      try { await fs.access(dir); }
      catch { await fs.mkdir(dir, { recursive: true }); }
    }
  };
  ensureLocalDirs().catch((err) =>
    console.error('❌ Failed to create local upload dirs:', err.message)
  );
}

// ── Storage: Cloudinary (production) ─────────────────────────────────────────

/**
 * Resolve the Cloudinary folder path from the request context.
 * Keeps all ForUni assets organised under a single top-level folder.
 */
const resolveCloudinaryFolder = (req, file) => {
  if (req.baseUrl?.includes('student'))    return 'backend/students';
  if (req.baseUrl?.includes('teacher'))    return 'backend/teachers';
  if (req.baseUrl?.includes('campus'))     return 'backend/campuses';
  if (req.baseUrl?.includes('parent'))     return 'backend/parents';
  if (file.mimetype === 'application/pdf') return 'backend/documents';
  if (file.fieldname === 'profileImage')   return 'backend/profiles';
  return 'backend/general';
};

/**
 * Build a deterministic, URL-safe public_id from the original filename.
 * A crypto-random suffix prevents collisions even for files with identical names.
 */
const buildPublicId = (file) => {
  const base   = path.basename(file.originalname || 'file', path.extname(file.originalname || ''));
  const safe   = base.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 50);
  const suffix = crypto.randomBytes(8).toString('hex');
  return `${safe}-${suffix}`;
};

// Cloudinary storage for images (JPEG/PNG/WEBP)
const cloudinaryImageStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder           : resolveCloudinaryFolder(req, file),
    allowed_formats  : ['jpg', 'jpeg', 'png', 'webp'],
    public_id        : buildPublicId(file),
    resource_type    : 'image',
    transformation   : [{ quality: 'auto', fetch_format: 'auto' }],
  }),
});

// Cloudinary storage for documents (PDF only)
const cloudinaryDocumentStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder          : 'backend/documents',
    allowed_formats : ['pdf'],
    public_id       : buildPublicId(file),
    resource_type   : 'raw', // PDFs are not images; use 'raw' resource_type
  }),
});

// ── Storage: Local disk (development) ────────────────────────────────────────

const buildLocalDiskStorage = (subFolder) =>
  multer.diskStorage({
    destination: (req, file, cb) => {
      let dir = `${UPLOAD_DIR}/temp`;
      if      (req.baseUrl?.includes('student')) dir = `${UPLOAD_DIR}/students`;
      else if (req.baseUrl?.includes('teacher')) dir = `${UPLOAD_DIR}/teachers`;
      else if (req.baseUrl?.includes('campus'))  dir = `${UPLOAD_DIR}/campuses`;
      else if (req.baseUrl?.includes('parent'))  dir = `${UPLOAD_DIR}/parents`;
      else if (subFolder)                        dir = `${UPLOAD_DIR}/${subFolder}`;
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext    = path.extname(file.originalname || '').toLowerCase();
      const base   = path.basename(file.originalname || 'file', ext)
        .replace(/[^a-z0-9]/gi, '-')
        .toLowerCase()
        .slice(0, 50);
      const suffix = crypto.randomBytes(8).toString('hex');
      cb(null, `${base}-${suffix}${ext}`);
    },
  });

// ── File filters ──────────────────────────────────────────────────────────────

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const ALLOWED_DOC_TYPES   = new Set(['application/pdf']);

/** Accept JPEG / PNG / WEBP only — GIF excluded (not useful for school management). */
const imageFilter = (req, file, cb) => {
  if (IS_PRODUCTION) {
    // In dev, log to assist debugging; in prod keep logs clean
    /* eslint-disable-next-line no-console */
  } else {
    console.log(`[Upload] imageFilter — ${file.fieldname} | ${file.mimetype} | ${file.originalname}`);
  }

  if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
    return cb(
      new Error(`Invalid image type "${file.mimetype}". Allowed: JPEG, PNG, WEBP.`),
      false,
    );
  }
  cb(null, true);
};

/**
 * Accept PDF documents only.
 * CSV/Excel import files bypass this filter — they use memoryStorage directly.
 */
const documentFilter = (req, file, cb) => {
  if (!ALLOWED_DOC_TYPES.has(file.mimetype)) {
    return cb(
      new Error(`Invalid document type "${file.mimetype}". Only PDF is accepted.`),
      false,
    );
  }
  cb(null, true);
};

// ── Multer instances ──────────────────────────────────────────────────────────

/**
 * Upload a profile image (students, teachers, parents).
 * Field name: 'profileImage'
 * Limit: 2 MB
 */
const uploadProfileImage = multer({
  storage    : IS_PRODUCTION ? cloudinaryImageStorage : buildLocalDiskStorage(),
  limits     : { fileSize: MAX_PROFILE_SIZE, files: 1 },
  fileFilter : imageFilter,
}).single('profileImage');

/**
 * Upload a campus cover image — CloudinaryStorage path (used for updates).
 * Field name: 'campus_image'
 * Limit: 5 MB
 */
const uploadCampusImage = multer({
  storage    : IS_PRODUCTION ? cloudinaryImageStorage : buildLocalDiskStorage('campuses'),
  limits     : { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter : imageFilter,
}).single('campus_image');

/**
 * Campus image upload — memory storage path (used for creation).
 * In production the file lands in req.file.buffer so the controller can
 * call uploadBufferToCloudinary() with an explicit timeout.
 * In development the file is still written to disk as usual.
 */
const uploadCampusImageMemory = multer({
  storage    : IS_PRODUCTION ? multer.memoryStorage() : buildLocalDiskStorage('campuses'),
  limits     : { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter : imageFilter,
}).single('campus_image');

/**
 * Upload a PDF document.
 * Field name: 'document'
 * Limit: 10 MB
 *
 * Note: CSV/Excel import files are NOT handled here.
 * They use multer.memoryStorage() inline in their respective routers
 * (result.router.js, student.router.js, teacher.router.js) so they are
 * parsed in memory and never written to disk or Cloudinary.
 */
const uploadDocument = multer({
  storage    : IS_PRODUCTION ? cloudinaryDocumentStorage : buildLocalDiskStorage('documents'),
  limits     : { fileSize: MAX_DOC_SIZE, files: 1 },
  fileFilter : documentFilter,
}).single('document');

// ── Error handling ────────────────────────────────────────────────────────────

/**
 * Express error middleware for Multer errors.
 * Must be placed after each upload middleware in the route chain:
 *   router.post('/', uploadProfileImage, handleMulterError, controller)
 */
const handleMulterError = (err, req, res, next) => {
  if (!err) return next();

  if (!IS_PRODUCTION) {
    console.error('[Upload] Multer error:', { code: err.code, message: err.message });
  }

  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE     : `File too large. Maximum allowed: ${MAX_PROFILE_SIZE / 1024 / 1024} MB for images, ${MAX_DOC_SIZE / 1024 / 1024} MB for documents.`,
      LIMIT_FILE_COUNT    : 'Too many files uploaded.',
      LIMIT_UNEXPECTED_FILE: `Unexpected field: "${err.field}". Check the field name.`,
    };
    return res.status(400).json({
      success : false,
      message : messages[err.code] || 'File upload error.',
    });
  }

  // Custom filter errors (invalid type, etc.)
  return res.status(400).json({
    success : false,
    message : err.message || 'File validation error.',
  });
};

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Delete a locally uploaded file on error (development only).
 * In production (Cloudinary), files are managed remotely; this is a no-op.
 * Called by genericEntity.controller.js in catch blocks.
 *
 * @param {Express.Multer.File} file - The file object from req.file
 */
const cleanupUploadedFile = async (file) => {
  if (!file?.path || IS_PRODUCTION) return;
  try {
    await fs.unlink(file.path);
  } catch {
    // Silently ignore — file may have already been removed
  }
};

/**
 * Build a public URL for a locally uploaded file (development only).
 * In production, Cloudinary returns the URL directly in file.path.
 * Called by campus.controller.js (imported but not yet actively used in routes).
 *
 * @param {Express.Multer.File|null} file
 * @returns {string|null}
 */
const getFileUrl = (file) => {
  if (!file) return null;
  // Cloudinary sets file.path to the remote URL in production
  if (IS_PRODUCTION) return file.path || null;
  const baseUrl    = process.env.BASE_URL || 'http://localhost:5000';
  const publicPath = file.path.replace(/\\/g, '/').replace(/^.*uploads\//, '');
  return `${baseUrl}/uploads/${publicPath}`;
};

/**
 * Upload a file buffer directly to Cloudinary with a hard timeout.
 * Replaces the multer-storage-cloudinary streaming path for campus creation
 * so the controller keeps full control over the upload and can surface a
 * clear error instead of hanging indefinitely.
 *
 * @param {Express.Multer.File} file   - Multer memory file (must have .buffer)
 * @param {string}              folder - Cloudinary destination folder
 * @param {number}             [ms]    - Timeout in ms (default 30 000)
 * @returns {Promise<string>}            Cloudinary secure_url
 */
const uploadBufferToCloudinary = (file, folder, ms = 30_000) =>
  new Promise((resolve, reject) => {
    if (!file?.buffer) {
      return reject(new Error('File buffer is missing — cannot upload to Cloudinary.'));
    }

    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Cloudinary upload timed out after 30 s. Please try again.'));
    }, ms);

    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type   : 'image',
        allowed_formats : ['jpg', 'jpeg', 'png', 'webp'],
        public_id       : buildPublicId(file),
        transformation  : [{ quality: 'auto', fetch_format: 'auto' }],
      },
      (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) return reject(error);
        resolve(result.secure_url);
      },
    );

    stream.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    stream.end(file.buffer);
  });

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Multer middleware (one name per responsibility)
  uploadProfileImage,
  uploadCampusImage,
  uploadCampusImageMemory,
  uploadDocument,

  // Cloudinary direct upload with timeout (used by campus.controller create)
  uploadBufferToCloudinary,

  // Error handling
  handleMulterError,

  // Utilities consumed by controllers
  cleanupUploadedFile,
  getFileUrl,

  // Exposed for tests / edge cases
  MAX_FILE_SIZE,
  MAX_PROFILE_SIZE,
  UPLOAD_DIR,
};