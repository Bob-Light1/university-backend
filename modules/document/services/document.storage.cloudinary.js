'use strict';

/**
 * @file document.storage.cloudinary.js
 * @description Cloudinary object-store backend for GED storage.
 *
 * Two decisions here are load-bearing and neither is arbitrary.
 *
 * 1. **Every object is uploaded as `resource_type: 'raw'`**, images included.
 *    Cloudinary strips a recognised image extension from the `public_id` of an
 *    `image` asset, so `documents/{campus}/images/{uuid}.png` comes back as
 *    `…/{uuid}` — and a delete that recomputes the id from `(campusId, category,
 *    fileName)` would then address nothing and silently report success. `raw`
 *    round-trips the id byte for byte, which is what lets the whole GED keep
 *    storing a bare filename in Mongo instead of requiring a schema migration.
 *    Nothing here uses Cloudinary transformations anyway: GED bytes are only ever
 *    delivered through an authenticated Express endpoint.
 *
 * 2. **Every object is `type: 'authenticated'`.** The GED's central rule is that
 *    files are NEVER served as static assets. A default `upload` asset is public
 *    to anyone holding its URL, which would move the entire access-control story
 *    from "the API decides" to "the URL is hard to guess" — for academic records,
 *    payslip-grade documents and student ID photos. Reads therefore go through a
 *    signed, short-lived URL fetched server-side and piped to the response, so the
 *    Express endpoint stays the only way in.
 *
 * Keys are the provider-neutral `{campusId}/{category}/{fileName}` built by the
 * service; this backend only prefixes the configured root folder.
 *
 * ⚠️ The signed-delivery round trip cannot be exercised offline — it needs a real
 * Cloudinary account. The unit suite pins the parameters this module sends
 * (resource_type, type, public_id, overwrite, invalidate) against a mocked SDK;
 * one live smoke test is still required before the first production deploy.
 */

const { Readable } = require('stream');
const cloudinary   = require('cloudinary').v2;

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * The SDK is configured HERE, not inherited.
 *
 * `shared/middleware/upload.js` also calls `cloudinary.config()`, and the Cloudinary
 * SDK keeps that configuration on a module-level singleton — so this file appeared to
 * work while it was only ever borrowing someone else's setup. Inside the server that
 * holds by accident (`app.js` loads the routes, which load `upload.js`). Outside it —
 * `scripts/migrate-ged-to-object-store.js`, `scripts/smoke-cloudinary.js`, any worker
 * that does not go through Express — nothing configures the SDK and every upload fails
 * with `Must supply api_key`.
 *
 * Calling it twice with the same values is harmless; depending on load order is not.
 */
cloudinary.config({
  cloud_name : process.env.CLOUDINARY_CLOUD_NAME,
  api_key    : process.env.CLOUDINARY_API_KEY,
  api_secret : process.env.CLOUDINARY_API_SECRET,
});

/** Root folder for every GED object. Segregates the GED from `backend/*` profile assets. */
const FOLDER_ROOT = process.env.DOC_STORAGE_FOLDER || 'ged';

/** Hard ceiling on any single Cloudinary round trip. */
const OP_TIMEOUT_MS = parseInt(process.env.DOC_STORAGE_TIMEOUT_MS || '30000', 10);

/** Lifetime of a signed read URL. Long enough for one fetch, short enough to be useless if leaked. */
const SIGNED_URL_TTL_S = 120;

/**
 * Cloudinary `public_id` for a storage key.
 *
 * With `resource_type: 'raw'` the extension is part of the id, so this is a pure
 * concatenation and its inverse is a prefix strip — no format inference anywhere.
 *
 * @param {string} key
 * @returns {string}
 */
const publicIdFor = (key) => `${FOLDER_ROOT}/${key}`;

/** Shared options identifying the asset class. Used by every call, so they cannot drift apart. */
const ASSET_OPTIONS = Object.freeze({ resource_type: 'raw', type: 'authenticated' });

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Signed, expiring delivery URL for a stored object.
 *
 * @param {string} key
 * @returns {string}
 */
const signedUrl = (key) => cloudinary.utils.private_download_url(
  publicIdFor(key),
  '',                                     // format is already carried by the public_id (raw)
  {
    ...ASSET_OPTIONS,
    expires_at: Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_S,
  },
);

/**
 * Fetches a stored object, returning the raw HTTP response.
 *
 * @param {string} key
 * @returns {Promise<Response>}
 */
const fetchObject = (key) => fetch(signedUrl(key), {
  signal: AbortSignal.timeout(OP_TIMEOUT_MS),
});

// ── Backend API ───────────────────────────────────────────────────────────────

/**
 * Uploads an object, overwriting any existing one at the same key.
 *
 * `overwrite` is deliberate: a PDF snapshot filename is derived from the document
 * version, so regenerating the same version must replace the object rather than
 * leave two assets where the caller believes there is one.
 *
 * @param {string} key
 * @param {Buffer} buffer
 * @returns {Promise<{ key: string, sizeBytes: number }>}
 */
const put = (key, buffer) => new Promise((resolve, reject) => {
  let settled = false;

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    reject(Object.assign(
      new Error(`Storage upload timed out after ${OP_TIMEOUT_MS} ms — please retry`),
      { statusCode: 503, retryAfter: 30 },
    ));
  }, OP_TIMEOUT_MS);

  const stream = cloudinary.uploader.upload_stream(
    { ...ASSET_OPTIONS, public_id: publicIdFor(key), overwrite: true, invalidate: true },
    (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) return reject(error);
      resolve({ key, sizeBytes: result?.bytes ?? buffer.length });
    },
  );

  stream.on('error', (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(err);
  });

  stream.end(buffer);
});

/**
 * Reads an object into memory.
 *
 * @param {string} key
 * @returns {Promise<Buffer|null>} null when the object does not exist.
 */
const get = async (key) => {
  const response = await fetchObject(key);
  if (!response.ok) return null;
  return Buffer.from(await response.arrayBuffer());
};

/**
 * Object metadata without transferring the bytes.
 *
 * @param {string} key
 * @returns {Promise<{ sizeBytes: number }|null>}
 */
const head = async (key) => {
  try {
    const resource = await cloudinary.api.resource(publicIdFor(key), { ...ASSET_OPTIONS });
    return { sizeBytes: resource?.bytes ?? 0 };
  } catch {
    return null;
  }
};

/**
 * Removes an object.
 *
 * @param {string} key
 * @returns {Promise<boolean>} false when it was already absent or the call failed.
 */
const remove = async (key) => {
  try {
    const result = await cloudinary.uploader.destroy(
      publicIdFor(key),
      { ...ASSET_OPTIONS, invalidate: true },
    );
    return result?.result === 'ok';
  } catch {
    return false;
  }
};

/**
 * Opens a readable stream over an object.
 *
 * The body is streamed rather than buffered so a 25 MB export does not sit in the
 * Node heap while it is being written to the client.
 *
 * @param {string} key
 * @returns {Promise<import('stream').Readable|null>}
 */
const openStream = async (key) => {
  const response = await fetchObject(key);
  if (!response.ok || !response.body) return null;
  return Readable.fromWeb(response.body);
};

module.exports = {
  name: 'cloudinary',
  put,
  get,
  head,
  remove,
  openStream,
  publicIdFor,
  signedUrl,
  FOLDER_ROOT,
};
