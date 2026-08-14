'use strict';

/**
 * @file storage-preflight.js
 * @description Boot-time assertion that GED file storage survives a redeploy.
 *
 * The GED writes imported files, PDF snapshots and content-block images through
 * `modules/document/services/document.storage.service.js`, which dispatches to one
 * of two backends chosen by `resolveStorageProvider()`. This check runs the SAME
 * resolution and refuses to start a production process whose chosen backend cannot
 * survive a deploy.
 *
 * It reads the same function the storage service dispatches on rather than
 * re-deriving the answer, because B8-① was precisely a disagreement between two
 * places that each believed something different about where files go: the storage
 * service wrote to disk unconditionally, while `upload.js` recorded — in a comment,
 * in another file — that the production filesystem is ephemeral. Nothing reconciled
 * them at runtime, so an unsafe deployment booted happily and lost every GED file on
 * the next deploy, with no error and no log line.
 *
 * This follows the fail-fast pattern of the database block in `server.js`: an unsafe
 * configuration must prevent boot, not produce a warning nobody reads.
 */

const fs   = require('fs').promises;
const fsc  = require('fs').constants;
const path = require('path');

const {
  STORAGE_PROVIDER,
  isCloudinaryConfigured,
  resolveStorageProvider,
} = require('./storage-provider');

/**
 * Repository root, resolved from this file's location (`shared/utils/`).
 * Resolved once at load: the answer cannot change while the process runs.
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Whether `target` lies inside `parent`.
 *
 * Deliberately NOT a string prefix test: `startsWith()` reports that
 * `/app/uploads-data` is inside `/app/uploads`, which is wrong and would reject a
 * perfectly good volume. `path.relative` answers structurally — a path outside the
 * parent always has to climb, or is absolute.
 *
 * @param {string} parent  absolute path of the containing directory
 * @param {string} target  absolute path to test
 * @returns {boolean}
 */
const isInside = (parent, target) => {
  const rel = path.relative(parent, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * Fails the boot with an actionable message.
 *
 * States the CONSEQUENCE, not only the condition: whoever reads this at 3 a.m. must
 * understand what is about to be lost without having read this file.
 *
 * @param {string} reason
 * @param {string} fix
 * @returns {never}
 */
const fail = (reason, fix) => {
  console.error('');
  console.error('❌ STORAGE PREFLIGHT FAILED — refusing to start.');
  console.error(`   Reason: ${reason}`);
  console.error('');
  console.error('   Consequence if ignored: every document, PDF snapshot and campus');
  console.error('   logo written by modules/document/ is at risk. Stored on a container');
  console.error('   filesystem (Render, Heroku, most container platforms) that data is');
  console.error('   DESTROYED on the next deploy, with no error and no log line.');
  console.error('');
  console.error(`   Fix: ${fix}`);
  console.error('');
  process.exit(1);
};

/**
 * Verifies that the LOCAL backend is durable.
 *
 * Production rules, all of which must hold:
 *   1. UPLOAD_DIR is set.
 *   2. It resolves OUTSIDE the repository — a mounted volume is never inside the
 *      source tree, so a path inside it is a container-local path in disguise.
 *   3. The directory exists and is writable — an unwritable volume is the same
 *      outage, found later and at a worse moment.
 *
 * @param {object} env
 * @returns {Promise<string>} the verified directory
 */
const verifyLocalBackend = async (env) => {
  const raw = env.UPLOAD_DIR;

  // Mirrors the fallback in document.storage.local.js and upload.js: with UPLOAD_DIR
  // unset, files land inside the repo. That branch is the data-loss branch, so the
  // effective directory is computed the same way here.
  const effectiveDir = raw && raw.trim()
    ? path.resolve(raw)
    : path.join(REPO_ROOT, 'uploads');

  if (!raw || !raw.trim()) {
    fail(
      'NODE_ENV=production with the local storage backend, but UPLOAD_DIR is not set, '
      + `so document storage would default to ${effectiveDir} (inside the deployed `
      + 'application directory).',
      'Either configure the object store — set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY '
      + 'and CLOUDINARY_API_SECRET and leave DOC_STORAGE_PROVIDER unset — or mount a '
      + 'persistent volume and set UPLOAD_DIR to its absolute path (e.g. /var/data/uploads).',
    );
  }

  if (isInside(REPO_ROOT, effectiveDir) || effectiveDir === REPO_ROOT) {
    fail(
      `UPLOAD_DIR resolves to ${effectiveDir}, which is inside the application directory `
      + `(${REPO_ROOT}). A mounted persistent volume is never inside the source tree.`,
      'Point UPLOAD_DIR at a path on a mounted volume, outside the deployed code, or '
      + 'switch to the Cloudinary backend.',
    );
  }

  try {
    await fs.access(effectiveDir, fsc.W_OK);
  } catch (err) {
    fail(
      `UPLOAD_DIR is set to ${effectiveDir} but it is not writable by this process (${err.code}).`,
      'Verify the volume is mounted at that path and that the container user owns it. '
      + 'Uploads would fail at request time otherwise — a slower version of the same outage.',
    );
  }

  return effectiveDir;
};

/**
 * Verifies that the CLOUDINARY backend is usable.
 *
 * Only the credentials are checked, and deliberately so: a boot-time round trip to a
 * third party makes startup depend on that party's availability, which trades a
 * data-loss failure for an availability failure. A missing credential, on the other
 * hand, is a configuration mistake that is certain to break every upload, so it must
 * stop the boot.
 *
 * The explicit override is the case worth guarding: `DOC_STORAGE_PROVIDER=cloudinary`
 * selects this backend regardless of whether it was ever configured.
 *
 * @param {object} env
 * @returns {void}
 */
const verifyCloudinaryBackend = (env) => {
  if (!isCloudinaryConfigured(env)) {
    fail(
      'The Cloudinary storage backend is selected but its credentials are incomplete '
      + '(CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET).',
      'Set the three credentials, or set DOC_STORAGE_PROVIDER=local and point UPLOAD_DIR '
      + 'at a mounted persistent volume.',
    );
  }
};

/**
 * Verifies that GED file storage is durable before the server accepts traffic.
 *
 * Outside production it never exits, and names both the backend and the effective
 * directory so a developer always knows where their uploads went.
 *
 * @param {object} [env=process.env]  injectable for tests
 * @returns {Promise<{ ok: boolean, provider: string, dir: string|null, persistent: boolean }>}
 */
const assertPersistentStorage = async (env = process.env) => {
  const provider     = resolveStorageProvider(env);
  const isProduction = env.NODE_ENV === 'production';

  if (!isProduction) {
    const dir = provider === STORAGE_PROVIDER.LOCAL
      ? (env.UPLOAD_DIR && env.UPLOAD_DIR.trim()
        ? path.resolve(env.UPLOAD_DIR)
        : path.join(REPO_ROOT, 'uploads'))
      : null;

    console.warn(`⚠️  [storage] Non-production boot — GED backend: ${provider}${dir ? ` → ${dir}` : ''}`);
    console.warn('⚠️  [storage] Persistence is NOT checked outside production.');
    return { ok: true, provider, dir, persistent: false };
  }

  if (provider === STORAGE_PROVIDER.CLOUDINARY) {
    verifyCloudinaryBackend(env);
    console.log('✅ [storage] Persistent document storage verified → Cloudinary object store');
    return { ok: true, provider, dir: null, persistent: true };
  }

  const dir = await verifyLocalBackend(env);
  console.log(`✅ [storage] Persistent document storage verified → ${dir} (local volume)`);
  return { ok: true, provider, dir, persistent: true };
};

module.exports = { assertPersistentStorage, isInside, REPO_ROOT };
