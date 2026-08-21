'use strict';

/**
 * @file ids.js
 * @description Deterministic ObjectId derivation for the test fixture.
 *
 * Every seeded document gets its `_id` from a stable business key
 * (`student:A:001`) instead of from `new ObjectId()`. Two consecutive runs
 * therefore produce byte-identical identifiers, which is what lets a test say
 * "student STU-A-001" by id, and what keeps CH-4 reference captures stable.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');

const { SEED_NAMESPACE, ANCHOR_DATE } = require('./seed.config');

/**
 * Derives a stable 12-byte ObjectId from a business key.
 *
 * MD5 is used as a fast, uniform key-to-bytes function, not as a security
 * primitive — the input space is a handful of literal strings in this file.
 *
 * @param {string} key - Stable business key, e.g. `student:A:001`.
 * @returns {mongoose.Types.ObjectId}
 */
const oid = (key) => {
  const digest = crypto.createHash('md5').update(`${SEED_NAMESPACE}:${key}`).digest('hex');
  return new mongoose.Types.ObjectId(digest.slice(0, 24));
};

/**
 * Derives `count` ids sharing a prefix: `oids('student:A', 3)` →
 * ids for `student:A:001`, `student:A:002`, `student:A:003`.
 *
 * @param {string} prefix
 * @param {number} count
 * @returns {mongoose.Types.ObjectId[]}
 */
const oids = (prefix, count) =>
  Array.from({ length: count }, (_, i) => oid(`${prefix}:${pad(i + 1)}`));

/**
 * Zero-pads a sequence number to the 3-digit form used by every fixture key and
 * by the human-readable references (`STU-A-001`).
 *
 * @param {number} n
 * @returns {string}
 */
const pad = (n) => String(n).padStart(3, '0');

/**
 * Derives a stable hex token (verification tokens, hall tickets, share codes).
 *
 * @param {string} key
 * @param {number} [length=32]
 * @returns {string}
 */
const token = (key, length = 32) =>
  crypto.createHash('sha256').update(`${SEED_NAMESPACE}:token:${key}`).digest('hex').slice(0, length);

// ── Frozen clock ──────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A date offset from the anchor. Positive is future, negative is past.
 *
 * @param {number} days
 * @param {number} [hours=0]
 * @returns {Date}
 */
const at = (days, hours = 0) =>
  new Date(ANCHOR_DATE.getTime() + days * DAY_MS + hours * 60 * 60 * 1000);

/**
 * The `createdAt` / `updatedAt` pair written explicitly on every document.
 *
 * `{ timestamps: true }` is mandatory on every schema (CLAUDE.md §5), and
 * Mongoose fills both fields with the wall clock without ever looking at the
 * seeded data. Left alone, "created on" columns and `createdAt` sorts would
 * change every day — exactly what the frozen anchor exists to prevent
 * (QA_TEST_STRATEGY.md §4.4).
 *
 * @param {number} daysAgo - Age of the document relative to the anchor.
 * @returns {{ createdAt: Date, updatedAt: Date }}
 */
const stamps = (daysAgo) => ({ createdAt: at(-daysAgo), updatedAt: at(-daysAgo) });

/**
 * bcrypt's own base64 alphabet — a salt outside it is rejected by the library.
 */
const BCRYPT_ALPHABET = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Builds the fixed bcrypt salt every fixture account is hashed with.
 *
 * bcrypt draws a random salt per call, so the same password produces a different
 * hash on every run — and two consecutive seeds would then differ byte for byte,
 * breaking the idempotence requirement of §4.4 on every account document.
 * Pinning the salt is safe here and only here: these credentials exist to be
 * published in `.generated/accounts.json`, and the guard forbids the seed from
 * ever reaching a database that is not a local test one.
 *
 * @param {number} rounds - Cost factor, 12 in this platform (CLAUDE.md §8).
 * @returns {string} A `$2b$<rounds>$<22 chars>` salt.
 */
const bcryptSalt = (rounds) => {
  const digest = crypto.createHash('sha256').update(`${SEED_NAMESPACE}:bcrypt-salt`).digest();
  const chars = Array.from({ length: 22 }, (_, i) => BCRYPT_ALPHABET[digest[i] % BCRYPT_ALPHABET.length]);

  return `$2b$${String(rounds).padStart(2, '0')}$${chars.join('')}`;
};

module.exports = { oid, oids, pad, token, at, stamps, bcryptSalt, DAY_MS };
