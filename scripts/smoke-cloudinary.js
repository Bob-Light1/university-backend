'use strict';

/**
 * @file smoke-cloudinary.js
 * @description One real round trip against the Cloudinary GED backend (B8-①).
 *
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * `tests/unit/document.storage.cloudinary.test.js` runs against a DOUBLE. It proves
 * the code asks for the right things — `resource_type: 'raw'`, `type: 'authenticated'`,
 * the exact `public_id` — which is the half that fails silently. It cannot prove that
 * the real Cloudinary ANSWERS the way this code expects, because a double always
 * answers the way its author imagined.
 *
 * The specific risk this covers: reads go through `cloudinary.utils.private_download_url()`,
 * written from the SDK documentation rather than from observation. If its shape is wrong,
 * uploads succeed and every download 404s.
 *
 * Nothing here touches real data. It writes one object under a `__smoke__` campus
 * segment with a random name, and removes it — including when a step fails.
 *
 * USAGE
 *   node scripts/smoke-cloudinary.js
 *
 * No database connection, no server. Needs only the three Cloudinary credentials.
 */

require('dotenv').config();

const crypto = require('crypto');

const backend = require('../modules/document/services/document.storage.cloudinary');
const { isCloudinaryConfigured } = require('../shared/utils/storage-provider');

/** Payload with a recognisable header, so a truncated or re-encoded read is obvious. */
const PAYLOAD = Buffer.from(`%PDF-1.4 smoke ${crypto.randomUUID()}\n${'x'.repeat(2048)}`);

/** Throwaway key. The `__smoke__` segment cannot collide with a real campus ObjectId. */
const KEY = `__smoke__/imported/${crypto.randomUUID()}.pdf`;

const results = [];

/**
 * Renders whatever a failure turns out to be.
 *
 * Cloudinary rejects with shapes that have no `.message` of their own — `{ error: {...} }`,
 * `{ http_code, name }`, or a raw network error. Printing `err.message` alone yields
 * "undefined", which tells the operator nothing at the exact moment they need to know
 * whether the problem is their credentials, their network, or this code.
 *
 * @param {unknown} err
 * @returns {string}
 */
const describeError = (err) => {
  if (typeof err === 'string') return err;
  if (err instanceof Error && err.message) return err.message;

  const parts = [
    err?.message,
    err?.error?.message,
    err?.name && err.name !== 'Error' ? err.name : null,
    err?.code,
    err?.http_code ? `HTTP ${err.http_code}` : null,
  ].filter(Boolean);

  if (parts.length) return parts.join(' — ');

  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
};

/**
 * Runs one named check, recording the outcome instead of throwing.
 *
 * Every step is attempted even after a failure: knowing that upload works and
 * download does not is a far more useful report than stopping at the first error.
 *
 * @param {string} label
 * @param {() => Promise<void>} fn
 * @returns {Promise<boolean>}
 */
const step = async (label, fn) => {
  try {
    await fn();
    results.push({ label, ok: true });
    console.log(`   ✅ ${label}`);
    return true;
  } catch (err) {
    const error = describeError(err);
    results.push({ label, ok: false, error });
    console.log(`   ❌ ${label}`);
    console.log(`      ${error}`);
    return false;
  }
};

/**
 * Records a step as skipped rather than running it.
 *
 * A check whose precondition never held must not report success. "the object is really
 * gone" passes trivially when the upload failed and nothing was ever there — a green
 * tick that means the opposite of what it reads.
 *
 * @param {string} label
 * @param {string} because
 */
const skip = (label, because) => {
  results.push({ label, ok: false, skipped: true, error: `skipped — ${because}` });
  console.log(`   ⏭️  ${label} — skipped (${because})`);
};

/** Fails the current step with a readable message. */
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const run = async () => {
  if (!isCloudinaryConfigured()) {
    console.error('\n❌ Cloudinary is not configured.');
    console.error('   Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.\n');
    process.exit(1);
  }

  console.log('\n🔥 Cloudinary smoke test — GED object store');
  console.log(`   Cloud  : ${process.env.CLOUDINARY_CLOUD_NAME}`);
  console.log(`   Folder : ${backend.FOLDER_ROOT}/`);
  console.log(`   Object : ${backend.publicIdFor(KEY)}\n`);

  const uploaded = await step('upload (put)', async () => {
    const out = await backend.put(KEY, PAYLOAD);
    assert(out.sizeBytes === PAYLOAD.length,
      `store reports ${out.sizeBytes} bytes, uploaded ${PAYLOAD.length} — the object was re-encoded, `
      + 'which means it was not stored as raw');
  });

  // Every later step reads or deletes what the upload was supposed to create. Running
  // them anyway would produce failures that all say the same thing — and one FALSE
  // GREEN: "the object is really gone" passes trivially when it was never there.
  if (!uploaded) {
    for (const label of ['metadata (head)', 'signed read (get)', 'signed stream (openStream)',
      'delete (remove)', 'the object is really gone']) {
      skip(label, 'nothing was uploaded');
    }
  } else {
    await step('metadata (head)', async () => {
      const meta = await backend.head(KEY);
      assert(meta !== null, 'head() found nothing at the key put() just wrote — the public_id does not round-trip');
      assert(meta.sizeBytes === PAYLOAD.length, `head() reports ${meta.sizeBytes} bytes, expected ${PAYLOAD.length}`);
    });

    // The step most likely to fail, and the reason this script exists.
    await step('signed read (get)', async () => {
      const buffer = await backend.get(KEY);
      assert(buffer !== null,
        'the signed download URL returned a non-OK response. Uploads work and downloads do not — '
        + 'check private_download_url() options against the SDK version in package.json');
      assert(buffer.equals(PAYLOAD), `read back ${buffer.length} bytes that differ from what was written`);
    });

    await step('signed stream (openStream)', async () => {
      const stream = await backend.openStream(KEY);
      assert(stream !== null, 'openStream() returned null — the export endpoint would 404');

      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      assert(Buffer.concat(chunks).equals(PAYLOAD), 'the streamed bytes differ from what was written');
    });

    const deleted = await step('delete (remove)', async () => {
      const removed = await backend.remove(KEY);
      assert(removed === true,
        'destroy() did not report ok — the identity used to delete does not match the one used to write, '
        + 'so hard-deleted documents would leave their files behind');
    });

    if (deleted) {
      await step('the object is really gone', async () => {
        assert(await backend.head(KEY) === null, 'head() still finds the object after remove()');
      });
    } else {
      skip('the object is really gone', 'the delete did not report success');
    }
  }

  const failed = results.filter((r) => !r.ok);

  console.log('');
  if (failed.length === 0) {
    console.log('✅ All six steps passed. The object-store backend works end to end.');
    console.log('   Safe to deploy with the Cloudinary backend active.\n');
    return 0;
  }

  console.log(`❌ ${failed.length} of ${results.length} steps did not pass — do NOT deploy yet.\n`);
  for (const { label, error } of failed) console.log(`   ${label}: ${error}`);

  // The commonest cause by far, and the one whose error text is least self-explanatory.
  const looksLikeNetwork = failed.some(({ error }) =>
    /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|fetch failed|getaddrinfo/i.test(error));
  if (looksLikeNetwork) {
    console.log('\n   This reads as a network problem, not a code problem: the host cannot reach');
    console.log('   Cloudinary at all. Re-run from a machine with outbound internet access.');
  }

  // A failure may leave the object behind. Say so rather than leaving litter unannounced.
  const stillThere = await backend.head(KEY).catch(() => null);
  if (stillThere) {
    console.log(`\n⚠️  Cleanup: ${backend.publicIdFor(KEY)} is still in the store — remove it manually.`);
  }
  console.log('');
  return 1;
};

if (require.main === module) {
  run()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('\n❌ Smoke test crashed:', err.message);
      console.error('   Nothing can be concluded about the backend from this.\n');
      process.exit(1);
    });
}

module.exports = { run };
