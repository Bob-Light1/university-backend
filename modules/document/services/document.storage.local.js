'use strict';

/**
 * @file document.storage.local.js
 * @description Local-filesystem backend for GED storage.
 *
 * Durable only when UPLOAD_DIR points at a mounted volume. On a host with an
 * ephemeral filesystem this backend loses every byte on the next deploy, which is
 * why `shared/utils/storage-preflight.js` refuses to boot production on it unless
 * the volume is verified.
 *
 * Keys are POSIX-style and campus-scoped: `{campusId}/{category}/{fileName}`.
 * They are identical across backends, so the same key resolves to the same logical
 * object whichever provider is active — that is what makes the swap possible
 * without touching a single caller or a single stored value.
 */

const fs     = require('fs').promises;
const fsSync = require('fs');
const path   = require('path');

/** Root of the campus-scoped tree. Mirrors the historical layout exactly. */
const BASE_UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.join(process.env.UPLOAD_DIR, 'documents')
  : path.join(__dirname, '..', '..', '..', 'uploads', 'documents');

/**
 * Absolute path for a storage key.
 *
 * The key is already validated by the service (`buildKey`), so this does not
 * re-check it; it only maps separators.
 *
 * @param {string} key
 * @returns {string}
 */
const resolvePath = (key) => path.join(BASE_UPLOAD_DIR, ...key.split('/'));

/**
 * Writes an object, creating the campus/category directory on demand.
 *
 * @param {string} key
 * @param {Buffer} buffer
 * @returns {Promise<{ key: string, sizeBytes: number }>}
 */
const put = async (key, buffer) => {
  const filePath = resolvePath(key);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);
  return { key, sizeBytes: buffer.length };
};

/**
 * Reads an object.
 *
 * @param {string} key
 * @returns {Promise<Buffer|null>} null when the object does not exist.
 */
const get = async (key) => {
  try {
    return await fs.readFile(resolvePath(key));
  } catch {
    return null;
  }
};

/**
 * Object metadata without transferring the bytes.
 *
 * @param {string} key
 * @returns {Promise<{ sizeBytes: number }|null>}
 */
const head = async (key) => {
  try {
    const { size } = await fs.stat(resolvePath(key));
    return { sizeBytes: size };
  } catch {
    return null;
  }
};

/**
 * Removes an object.
 *
 * @param {string} key
 * @returns {Promise<boolean>} false when it was already absent.
 */
const remove = async (key) => {
  try {
    await fs.unlink(resolvePath(key));
    return true;
  } catch {
    return false;
  }
};

/**
 * Opens a readable stream over an object.
 *
 * Streaming rather than buffering matters here: an imported file may be 25 MB and
 * the export endpoint has no reason to hold it in memory.
 *
 * @param {string} key
 * @returns {Promise<import('stream').Readable|null>}
 */
const openStream = async (key) => {
  const filePath = resolvePath(key);
  try {
    await fs.access(filePath);
  } catch {
    return null;
  }
  return fsSync.createReadStream(filePath);
};

module.exports = {
  name: 'local',
  put,
  get,
  head,
  remove,
  openStream,
  BASE_UPLOAD_DIR,
  resolvePath,
};
