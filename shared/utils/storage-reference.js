'use strict';

/**
 * @file storage-reference.js
 * @description One meaning for an uploaded file, whatever backend stored it.
 *
 * `shared/middleware/upload.js` swaps its storage engine on `NODE_ENV`, so
 * `req.file.path` is an absolute filesystem path in development and an https
 * Cloudinary URL in production. Persisting that raw value writes a path to a file
 * on a developer's laptop into the database (B7-②) — and leaves nothing a
 * deletion could act on, because a URL is a way to *read* an asset, not a handle
 * to *manage* it (B7-③).
 *
 * This module replaces only the live responsibility of `shared/utils/file-upload.js`,
 * which is a fossil written for `formidable` (`file.originalFilename`,
 * `file.filepath`) — a library that is not in package.json.
 */

const path       = require('path');
const fs         = require('fs').promises;
const cloudinary = require('cloudinary').v2;

const { UPLOAD_DIR } = require('../middleware/upload');
const { STORAGE_PROVIDER } = require('./storage-reference.schema');

/**
 * @typedef {object} StorageRef
 * @property {'cloudinary'|'local'|'memory'} provider
 * @property {string|null} url          browser-usable in every environment
 * @property {string|null} storageKey   what a deletion needs
 */

/**
 * Public URL of a locally stored asset, built from its key relative to UPLOAD_DIR.
 *
 * Deliberately not `getFileUrl`, which rewrites the absolute path by stripping
 * everything up to the literal substring `uploads/`. That match holds only while
 * UPLOAD_DIR ends in `uploads` — set `UPLOAD_DIR=/data/files` and the rewrite
 * finds nothing, so the absolute filesystem path is returned and persisted. That
 * is the very defect this module exists to close, reached by another route.
 * `app.js` serves UPLOAD_DIR statically under `/uploads`, so the key is the
 * only variable part.
 *
 * @param {string} storageKey  path relative to UPLOAD_DIR
 * @returns {string}
 */
const localUrl = (storageKey) => {
  const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
  return `${baseUrl}/uploads/${storageKey.split(path.sep).join('/')}`;
};

/**
 * Classifies a Multer file by its OWN SHAPE rather than by `NODE_ENV`.
 *
 * Re-reading the environment would already be wrong in this codebase:
 * `uploadCampusImageMemory` uses `multer.memoryStorage()` in production, so a
 * production file can be neither Cloudinary nor local. The environment describes
 * the *default* storage; the file object describes what actually happened.
 *
 * Shapes, verified against the dependencies rather than assumed:
 *   - CloudinaryStorage    → `{ path: secure_url, size, filename: public_id }`
 *   - multer diskStorage   → `{ path: '/abs/path/file.png', destination, filename }`
 *   - multer memoryStorage → `{ buffer, size }`, no `path`
 *
 * @param {Express.Multer.File|null|undefined} file
 * @returns {StorageRef|null} null when there is no file
 */
const describeUploadedFile = (file) => {
  if (!file) return null;

  // Nothing persisted yet: no URL and nothing to delete. Returned explicitly
  // rather than forced into one of the other branches — the caller (campus
  // creation, which then calls uploadBufferToCloudinary) must handle it.
  if (!file.path && file.buffer) {
    return { provider: STORAGE_PROVIDER.MEMORY, url: null, storageKey: null };
  }

  if (typeof file.path === 'string' && /^https?:\/\//i.test(file.path)) {
    return {
      provider:   STORAGE_PROVIDER.CLOUDINARY,
      url:        file.path,          // already the secure_url
      // Cloudinary's response public_id INCLUDES the folder, which is why the
      // storage library's own _removeFile calls destroy(file.filename) with no
      // concatenation. Use it verbatim.
      storageKey: file.filename || null,
    };
  }

  // Relative to UPLOAD_DIR: an absolute path is not portable between a laptop and
  // a container, and it is exactly the value that leaked into MongoDB.
  const storageKey = path.relative(UPLOAD_DIR, file.path);

  return {
    provider:   STORAGE_PROVIDER.LOCAL,
    url:        localUrl(storageKey),
    storageKey,
  };
};

/**
 * Deletes whatever `describeUploadedFile` recorded.
 *
 * Never throws. Resolves to `{ removed, reason? }` and — unlike the `deleteFile`
 * it replaces, which collapsed every outcome into a bare `false` — distinguishes:
 *   - `removed: true`                        the asset is gone
 *   - `removed: false, reason: 'not_found'`  already absent; idempotent, fine
 *   - `removed: false, reason: <other>`      a real failure, worth alerting on
 *
 * An operation that cannot tell its failures apart cannot be monitored, which is
 * exactly why the old bug survived: the log said "File not found" and everyone
 * read it as noise.
 *
 * @param {StorageRef|null} ref
 * @returns {Promise<{ removed: boolean, reason?: string }>}
 */
const removeStoredFile = async (ref) => {
  if (!ref || !ref.storageKey) {
    return { removed: false, reason: 'no_reference' };
  }

  if (ref.provider === STORAGE_PROVIDER.CLOUDINARY) {
    try {
      const res = await cloudinary.uploader.destroy(ref.storageKey, { invalidate: true });
      // Cloudinary answers { result: 'ok' | 'not found' } rather than throwing.
      if (res?.result === 'ok')        return { removed: true };
      if (res?.result === 'not found') return { removed: false, reason: 'not_found' };
      return { removed: false, reason: `cloudinary:${res?.result ?? 'unknown'}` };
    } catch (err) {
      return { removed: false, reason: `cloudinary_error:${err.message}` };
    }
  }

  if (ref.provider === STORAGE_PROVIDER.LOCAL) {
    // Refuse a key that escapes UPLOAD_DIR. It comes from our own describe()
    // today, but the moment it is persisted it becomes data on the next read.
    const target = path.resolve(UPLOAD_DIR, ref.storageKey);
    if (!target.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) {
      return { removed: false, reason: 'path_traversal_refused' };
    }
    try {
      await fs.unlink(target);
      return { removed: true };
    } catch (err) {
      if (err.code === 'ENOENT') return { removed: false, reason: 'not_found' };
      return { removed: false, reason: `fs_error:${err.code || err.message}` };
    }
  }

  return { removed: false, reason: 'unsupported_provider' };
};

/**
 * Removes the asset an entity's previous profile image pointed at, logging only
 * the outcomes that are actually problems.
 *
 * `not_found` is idempotent and silent; `no_reference` means the row predates
 * `profileImageRef` and holds a value nothing can act on — see
 * `scripts/migrate-profile-image-ref.js`.
 *
 * @param {StorageRef|null} ref
 * @param {string} context  label used in the log line
 * @returns {Promise<{ removed: boolean, reason?: string }>}
 */
const discardPreviousUpload = async (ref, context) => {
  const outcome = await removeStoredFile(ref);

  if (!outcome.removed && outcome.reason !== 'not_found' && outcome.reason !== 'no_reference') {
    console.error(`⚠️  [storage] ${context}: orphaned asset ${ref?.storageKey} — ${outcome.reason}`);
  }

  return outcome;
};

module.exports = {
  describeUploadedFile,
  removeStoredFile,
  discardPreviousUpload,
  STORAGE_PROVIDER,
};
