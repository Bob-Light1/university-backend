'use strict';

/**
 * @file counter.model.js
 * @description Atomic MongoDB counter for generating unique references.
 *
 *  Usage:
 *  ─────────────────────────
 *  const { nextSequence } = require('./counter.model');
 *  const seq = await nextSequence('result_2025'); // → 1, 2, 3…
 *  const ref = `RES-2025-${String(seq).padStart(5, '0')}`; // → "RES-2025-00001"
 */

const mongoose = require('mongoose');

const CounterSchema = new mongoose.Schema(
  {
    /** Counter identifier (e.g. "result_2025", "grading_scale_2025") */
    _id: { type: String, required: true },

    /** Current counter value — incremented atomically */
    seq: { type: Number, default: 0 },
  },
  {
    // No timestamps here — the counter is purely technical
    collection: 'counters',
    versionKey:  false,
  }
);

const Counter = mongoose.model('Counter', CounterSchema);

/**
 * Atomically increments the counter `name` and returns the new value.
 * Creates the counter document if it does not exist (upsert: true).
 *
 * @param  {string} name  - Counter identifier (e.g. "result_2025")
 * @returns {Promise<number>}  Next sequence (starts at 1)
 */
const nextSequence = async (name) => {
  const doc = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return doc.seq;
};

/**
 * Generates a unique human-readable reference for a result.
 * Format: "RES-YYYY-NNNNN" (e.g. "RES-2025-00042")
 *
 * @param  {number} [year]  - Year (default: current year)
 * @returns {Promise<string>}
 */
const nextResultRef = async (year = new Date().getFullYear()) => {
  const seq = await nextSequence(`result_${year}`);
  return `RES-${year}-${String(seq).padStart(5, '0')}`;
};

module.exports = { Counter, nextSequence, nextResultRef };