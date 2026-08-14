'use strict';

/**
 * @file storage-preflight.js
 * @description Boot-time assertion that GED file storage survives a redeploy.
 *
 * `modules/document/services/document.storage.service.js` writes every imported
 * file, PDF snapshot, QR code and campus logo to the local filesystem, with no
 * branch on NODE_ENV — while `shared/middleware/upload.js` records, in a comment,
 * in a different file, that the production host has an ephemeral filesystem.
 * Nothing reconciled the two at runtime, so an unsafe deployment booted happily
 * and lost every GED file on the next deploy, with no error and no log line
 * (B8-①).
 *
 * This follows the fail-fast pattern of the database block in `server.js`: an
 * unsafe configuration must prevent boot, not produce a warning nobody reads.
 *
 * It does NOT make storage persistent. It makes an unsafe deployment refuse to
 * start. Actually persisting the data is an operations decision — mount a volume
 * and point UPLOAD_DIR at it, or migrate the storage service to an object store
 * (its interface was designed to be swapped).
 */

const fs   = require('fs').promises;
const fsc  = require('fs').constants;
const path = require('path');

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
 * States the CONSEQUENCE, not only the condition: whoever reads this at 3 a.m.
 * must understand what is about to be lost without having read this file.
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
  console.error('   Consequence if ignored: every document, PDF snapshot, QR code and');
  console.error('   campus logo written by modules/document/ is stored on the container');
  console.error('   filesystem. On a host with an ephemeral filesystem (Render, Heroku,');
  console.error('   most container platforms) that data is DESTROYED on the next deploy,');
  console.error('   with no error and no log line.');
  console.error('');
  console.error(`   Fix: ${fix}`);
  console.error('');
  process.exit(1);
};

/**
 * Verifies that GED file storage is durable before the server accepts traffic.
 *
 * Production rules, all of which must hold:
 *   1. UPLOAD_DIR is set.
 *   2. It resolves OUTSIDE the repository — a mounted volume is never inside the
 *      source tree, so a path inside it is a container-local path in disguise.
 *   3. The directory exists and is writable — an unwritable volume is the same
 *      outage, found later and at a worse moment.
 *
 * Outside production it never exits, and names the effective directory so a
 * developer always knows where their uploads went.
 *
 * @param {object} [env=process.env]  injectable for tests
 * @returns {Promise<{ ok: boolean, dir: string, persistent: boolean }>}
 */
const assertPersistentStorage = async (env = process.env) => {
  const isProduction = env.NODE_ENV === 'production';
  const raw = env.UPLOAD_DIR;

  // Mirrors the fallback in document.storage.service.js and upload.js: with
  // UPLOAD_DIR unset, files land inside the repo. That branch is the data-loss
  // branch, so the effective directory is computed the same way here.
  const effectiveDir = raw && raw.trim()
    ? path.resolve(raw)
    : path.join(REPO_ROOT, 'uploads');

  if (!isProduction) {
    console.warn(`⚠️  [storage] Non-production boot — document uploads → ${effectiveDir}`);
    console.warn('⚠️  [storage] Persistence is NOT checked outside production.');
    return { ok: true, dir: effectiveDir, persistent: false };
  }

  if (!raw || !raw.trim()) {
    fail(
      'NODE_ENV=production but UPLOAD_DIR is not set, so document storage would default '
      + `to ${effectiveDir} (inside the deployed application directory).`,
      'Mount a persistent volume and set UPLOAD_DIR to its absolute path '
      + '(e.g. UPLOAD_DIR=/var/data/uploads), or migrate modules/document/ to a remote '
      + 'object store — the storage service interface is designed to be swapped.',
    );
  }

  if (isInside(REPO_ROOT, effectiveDir) || effectiveDir === REPO_ROOT) {
    fail(
      `UPLOAD_DIR resolves to ${effectiveDir}, which is inside the application directory `
      + `(${REPO_ROOT}). A mounted persistent volume is never inside the source tree.`,
      'Point UPLOAD_DIR at a path on a mounted volume, outside the deployed code.',
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

  console.log(`✅ [storage] Persistent document storage verified → ${effectiveDir}`);
  return { ok: true, dir: effectiveDir, persistent: true };
};

module.exports = { assertPersistentStorage, isInside, REPO_ROOT };
