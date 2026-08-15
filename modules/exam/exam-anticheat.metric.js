'use strict';

/**
 * @file exam-anticheat.metric.js
 * @description Agreement measure over CATEGORICAL exam answers, and the rules built on it.
 *
 * Pure functions, no database, no `req` — so the property that matters (does this measure
 * say what we think it says) is testable exhaustively rather than by inspection.
 *
 * ── Why this replaced cosine similarity ─────────────────────────────────────────────
 *
 * `selectedOption` is a `Number` in the schema, but it is an option INDEX — a label, not a
 * quantity. Option 3 is not "three times" option 1, and the distance between option 0 and
 * option 1 is not one unit of anything. Cosine similarity is a geometric measure: it asks
 * about the ANGLE between two vectors, which is a question that has no meaning over labels.
 *
 * The consequences were not subtle:
 *
 *   cosine([3,3,3], [1,1,1]) === 1.0   two papers sharing ZERO answers, flagged as identical
 *   cosine([1,2,3], [2,4,6]) === 1.0   any two proportional papers, flagged
 *   cosine([0,0,0], [0,0,0]) === 0.0   two IDENTICAL papers, not flagged at all
 *
 * The last one is the archetypal copied paper, and it scored zero because the old
 * implementation clamped unanswered (-1) to 0 and then divided by a zero norm. Exhaustively,
 * over every three-question four-option pair: 16.0% of all ZERO-agreement pairs crossed the
 * 0.85 threshold (276 of 1728).
 *
 * Values that are labels admit exactly one operation: equality. That single `===` in
 * `answerAgreement` is the whole correction.
 */

/** Every representation of "this question was not answered". */
const isBlank = (value) => value === null || value === undefined || value === -1;

/**
 * Agreement between two ALIGNED answer vectors — index i is the same question for both
 * students, which the caller guarantees by building both from the session's canonical
 * `questionOrder`.
 *
 * @param {Array<number|null|undefined>} a
 * @param {Array<number|null|undefined>} b
 * @returns {{score: number|null, common: number, matched: number, bothBlank: number}}
 *   `score` is `null` — NOT 0 — when the pair share no commonly-answered question. "Not
 *   comparable" is a different fact from "not similar", and making it a distinct value
 *   forces the caller to handle it. Returning 0 would quietly assert innocence, 1 would
 *   quietly assert guilt, and NaN would "work" only because `NaN >= threshold` is false,
 *   which is luck rather than design.
 * @throws {Error} when the vectors are not aligned — comparing different questions silently
 *   is the failure this whole file exists to stop.
 */
const answerAgreement = (a, b) => {
  if (a.length !== b.length) {
    throw new Error(`answerAgreement: vectors must be aligned (${a.length} vs ${b.length})`);
  }

  let common    = 0; // questions BOTH students answered
  let matched   = 0; // ...and answered identically
  let bothBlank = 0; // questions BOTH students left blank

  for (let i = 0; i < a.length; i++) {
    const blankA = isBlank(a[i]);
    const blankB = isBlank(b[i]);

    if (blankA && blankB) { bothBlank += 1; continue; }
    if (blankA || blankB) continue; // one answered, one did not — evidence of nothing

    common += 1;
    // Option 0 compares exactly like any other option.
    if (a[i] === b[i]) matched += 1;
  }

  return {
    score: common === 0 ? null : matched / common,
    common,
    matched,
    // Reported separately and never folded into `score`. Two students abandoning at the
    // same question is arguably a strong collusion signal in a timed exam, but it is
    // evidence of a different kind — it says nothing about the CONTENT of their answers.
    // Mixing it in would let a pair who answered nothing at all score 1.0.
    bothBlank,
  };
};

/**
 * Should this pair be flagged for human review?
 *
 * `minCommon` is a floor on the DENOMINATOR, and it is not optional in practice: without
 * it, two students who each answered only the first two questions and agree on both score a
 * perfect 1.0 and outrank a pair agreeing on 47 of 50. Any threshold on a ratio needs a
 * floor on the sample it was computed from.
 *
 * @param {{score: number|null, common: number}} agreement
 * @param {{threshold?: number, minCommon?: number}} [options]
 * @returns {boolean}
 */
const shouldFlag = (agreement, { threshold, minCommon } = {}) => {
  if (agreement.score === null) return false;     // not comparable
  if (agreement.common < minCommon) return false; // sample too small to mean anything
  return agreement.score >= threshold;
};

/**
 * Whether a session still needs an anti-cheat scan.
 *
 * The marker replaces the old "completed in the last 48 h" proxy, which — run every 24 h —
 * scanned every session twice and, with an append-only `$push`, recorded every finding
 * twice. One field closes a second defect at the same time: the candidate set now DRAINS,
 * because a scanned session stops matching, so a backlog larger than one batch is picked up
 * on the next run instead of being permanently invisible behind an unsorted `.limit()`.
 *
 * @param {{antiCheatScannedAt?: Date|null, lastSubmissionAt?: Date|null}} session
 * @returns {boolean}
 */
const shouldRescan = (session) => {
  if (!session.antiCheatScannedAt) return true; // never scanned
  // A submission that landed after the last scan invalidates it: new paper, new pairs.
  // `submitExam` gates on the SUBMISSION's status, not the session's, so an attempt left
  // IN_PROGRESS can still be submitted after the session is COMPLETED and already scanned.
  if (session.lastSubmissionAt && session.lastSubmissionAt > session.antiCheatScannedAt) {
    return true;
  }
  return false;
};

/**
 * Turns flagged pairs into `bulkWrite` operations.
 *
 * The previous implementation `await`ed two `findByIdAndUpdate` calls INSIDE the O(n²)
 * pairwise loop, under a comment reading "non-blocking, fire-and-forget" — which `await` is
 * precisely not. Collecting first also makes the scan a single unit: the flags and the
 * `antiCheatScannedAt` stamp can be issued together, so a run that dies mid-way does not
 * leave a session marked scanned with half its flags written.
 *
 * Returned rather than executed, so the shape is testable without a database.
 *
 * @param {Array<{submissionA, submissionB, studentA, studentB, score: number, common: number}>} pairs
 * @param {{threshold?: number}} [options]
 * @returns {Array<Object>} bulkWrite operations
 */
const buildFlagWrites = (pairs, { threshold } = {}) => {
  const ops = [];
  const at  = new Date();

  for (const pair of pairs) {
    const detail = (otherStudent) =>
      `Answer agreement ${(pair.score * 100).toFixed(1)}% on ${pair.common} commonly-answered `
      + `question(s) (threshold ${(threshold * 100).toFixed(0)}%) with student ${otherStudent}`;

    ops.push({
      updateOne: {
        filter: { _id: pair.submissionA },
        update: {
          $push: {
            antiCheatFlags: {
              type: 'SIMILARITY_FLAG', detail: detail(pair.studentB), timestamp: at,
            },
          },
        },
      },
    });
    ops.push({
      updateOne: {
        filter: { _id: pair.submissionB },
        update: {
          $push: {
            antiCheatFlags: {
              type: 'SIMILARITY_FLAG', detail: detail(pair.studentA), timestamp: at,
            },
          },
        },
      },
    });
  }

  return ops;
};

module.exports = { answerAgreement, shouldFlag, shouldRescan, buildFlagWrites, isBlank };
