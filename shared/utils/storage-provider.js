'use strict';

/**
 * @file storage-provider.js
 * @description Single source of truth for WHICH storage backend the GED uses.
 *
 * Deliberately in `shared/` rather than inside `modules/document/`: two very
 * different consumers need the same answer, and they must not be able to disagree.
 *   - `modules/document/services/document.storage.service.js` dispatches on it;
 *   - `shared/utils/storage-preflight.js` decides at boot whether the deployment
 *     is safe to start on it.
 *
 * B8-① was exactly a disagreement of this kind: the storage service wrote to disk
 * unconditionally while `shared/middleware/upload.js` recorded — in a comment, in
 * another file — that the production host's filesystem is ephemeral. Nothing
 * reconciled the two at runtime. A boot check that re-derived the provider on its
 * own would recreate that gap in a new place.
 */

/** Provider identifiers accepted by DOC_STORAGE_PROVIDER. */
const STORAGE_PROVIDER = Object.freeze({
  LOCAL:      'local',
  CLOUDINARY: 'cloudinary',
});

/**
 * Whether the three Cloudinary credentials are present.
 *
 * Checked rather than assumed: a half-configured deployment must be caught at boot,
 * not by the first upload of the day.
 *
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
const isCloudinaryConfigured = (env = process.env) => Boolean(
  env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET,
);

/**
 * Resolves the active storage backend.
 *
 * Order, most explicit first:
 *   1. `DOC_STORAGE_PROVIDER` — an operator override, honoured in every environment.
 *      Lets a developer exercise the object-store path locally, and lets an operator
 *      who genuinely has a mounted volume keep the filesystem in production.
 *   2. Production with Cloudinary credentials → object store.
 *   3. Otherwise → local filesystem.
 *
 * Landing on `local` in production is NOT silently accepted: `assertPersistentStorage()`
 * then demands a verified volume before the process is allowed to serve traffic.
 *
 * An unrecognised `DOC_STORAGE_PROVIDER` value is ignored rather than honoured — a
 * typo must not select a backend nobody intended.
 *
 * @param {object} [env=process.env]
 * @returns {'local'|'cloudinary'}
 */
const resolveStorageProvider = (env = process.env) => {
  const explicit = String(env.DOC_STORAGE_PROVIDER || '').trim().toLowerCase();
  if (explicit === STORAGE_PROVIDER.LOCAL || explicit === STORAGE_PROVIDER.CLOUDINARY) {
    return explicit;
  }
  if (env.NODE_ENV === 'production' && isCloudinaryConfigured(env)) {
    return STORAGE_PROVIDER.CLOUDINARY;
  }
  return STORAGE_PROVIDER.LOCAL;
};

module.exports = {
  STORAGE_PROVIDER,
  isCloudinaryConfigured,
  resolveStorageProvider,
};
