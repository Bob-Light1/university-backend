'use strict';

/**
 * @file exam-anticheat.cron.js
 * @description Batch anti-cheat analysis over MCQ answer papers.
 *
 *  Triggered manually after ExamSession → COMPLETED, or scheduled nightly.
 *  Compares every pair of papers within a session on the fraction of commonly-answered
 *  questions they answered identically. Pairs at or above the threshold are flagged for
 *  human review — no automated penalty is applied (detection-only approach per spec §7.3).
 *
 *  The measure itself, and why it is not a cosine similarity, lives in
 *  `exam-anticheat.metric.js`. This file is the orchestration: which sessions to scan, in
 *  what order, and how the findings are written.
 *
 *  Schedule: nightly at 03:00 UTC, registered by `shared/lib/register-jobs.js`.
 *  Historical usage (no longer the registration site):
 *    const cron = require('node-cron');
 *    const { runAntiCheatJob } = require('./modules/exam').service;
 *    cron.schedule('0 3 * * *', runAntiCheatJob); // Nightly at 03:00
 *
 *  Manual trigger (per session):
 *    const { analyzeSession } = require('./exam-anticheat.cron');
 *    await analyzeSession(sessionId);
 */

const mongoose   = require('mongoose');
const repo       = require('./exam.repository');
const examConfig = require('./exam.config');
const {
  answerAgreement, shouldFlag, shouldRescan, buildFlagWrites,
} = require('./exam-anticheat.metric');

const AGREEMENT_THRESHOLD = examConfig.antiCheatAgreementThreshold; // default 0.85
const MIN_COMMON_ANSWERS  = examConfig.antiCheatMinCommonAnswers;   // default 5
const BATCH_SIZE          = examConfig.antiCheatBatchSize;          // sessions per run

const FLAG_RULES = { threshold: AGREEMENT_THRESHOLD, minCommon: MIN_COMMON_ANSWERS };

/**
 * Build an answer vector for a submission, aligned on the session's canonical question
 * order so index i is the same question for every student.
 *
 * Unanswered is `null`, not `-1`: the metric treats blanks as absence of evidence, and a
 * sentinel that is also a number invites exactly the arithmetic that produced the defect
 * this file was rewritten for.
 *
 * @param {Array}  answers       submission.answers
 * @param {Array}  questionOrder ordered questionId strings (session canonical order)
 * @returns {Array<number|null>}
 */
const _buildVector = (answers, questionOrder) => {
  const map = {};
  for (const a of answers) {
    map[a.questionId.toString()] = a.selectedOption ?? null;
  }
  return questionOrder.map((qid) => (map[qid] === undefined ? null : map[qid]));
};

// ─── Per-session analysis ────────────────────────────────────────────────────

/**
 * Runs the pairwise agreement analysis for one exam session.
 * Writes suspicion flags to ExamSubmission.antiCheatFlags (append-only), then stamps the
 * session as scanned.
 *
 * Write order is deliberate: flags first, `antiCheatScannedAt` second. A run that dies
 * between the two re-scans the session on the next pass — which now costs nothing beyond
 * the duplicate flags it would create, whereas the reverse order would mark a session
 * scanned with none of its findings recorded and never look at it again.
 *
 * @param {string|ObjectId} sessionId
 * @returns {Promise<{ sessionId: string, pairsChecked: number, flagged: number, skipped?: string }>}
 */
const analyzeSession = async (sessionId) => {
  if (!mongoose.Types.ObjectId.isValid(sessionId)) {
    return { sessionId: String(sessionId), pairsChecked: 0, flagged: 0 };
  }

  const session = await repo.findSessionByIdLean(sessionId);
  if (!session) return { sessionId: String(sessionId), pairsChecked: 0, flagged: 0 };

  // Canonical question order (MCQ only, based on session.questions array)
  const questionOrder = (session.questions || [])
    .map((q) => q.questionId.toString());

  if (!questionOrder.length) {
    // Stamped for the same reason as the <2-submissions case below: a session with no
    // questions has been considered. Every early return that leaves the marker unset makes
    // the session a permanent candidate, re-read on every run forever, and it is the head
    // of the sorted queue — so it would also hold back the batch behind it.
    await repo.markSessionAntiCheatScanned(sessionId);
    return { sessionId: String(sessionId), pairsChecked: 0, flagged: 0 };
  }

  const submissions = await repo.findSubmissionsForAntiCheat(sessionId);

  if (submissions.length < 2) {
    // Still stamped: a session with fewer than two papers has been considered and has
    // nothing to find. Leaving it unstamped would make it a permanent candidate.
    await repo.markSessionAntiCheatScanned(sessionId);
    return { sessionId: String(sessionId), pairsChecked: 0, flagged: 0 };
  }

  // Pre-compute vectors
  const vectors = submissions.map((s) => ({
    submissionId: s._id,
    studentId:    s.student,
    vec:          _buildVector(s.answers || [], questionOrder),
  }));

  let pairsChecked   = 0;
  const flaggedPairs = [];

  // Upper-triangular pairwise comparison — O(n²/2), and now containing no I/O at all.
  // The previous version awaited two writes per flagged pair from inside this loop, under
  // a comment describing them as "non-blocking, fire-and-forget".
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const agreement = answerAgreement(vectors[i].vec, vectors[j].vec);
      pairsChecked++;

      if (shouldFlag(agreement, FLAG_RULES)) {
        flaggedPairs.push({
          submissionA: vectors[i].submissionId,
          submissionB: vectors[j].submissionId,
          studentA:    vectors[i].studentId,
          studentB:    vectors[j].studentId,
          score:       agreement.score,
          common:      agreement.common,
        });
      }
    }
  }

  await repo.bulkPushAntiCheatFlags(
    buildFlagWrites(flaggedPairs, { threshold: AGREEMENT_THRESHOLD }),
  );
  await repo.markSessionAntiCheatScanned(sessionId);

  console.log(
    `[AntiCheatCron] Session ${sessionId}: ${pairsChecked} pairs checked, `
    + `${flaggedPairs.length} flagged (agreement >= ${AGREEMENT_THRESHOLD} over `
    + `>= ${MIN_COMMON_ANSWERS} common answers).`
  );
  return { sessionId: String(sessionId), pairsChecked, flagged: flaggedPairs.length };
};

// ─── Nightly batch job ────────────────────────────────────────────────────────

/**
 * Processes COMPLETED sessions that have not yet been scanned, oldest first.
 *
 * "Not yet scanned" is now the `antiCheatScannedAt` marker rather than "completed in the
 * last 48 h". The proxy was wrong in two independent ways, and one field closes both:
 *
 *   - a 48 h window read by a job running every 24 h selected each session on two
 *     consecutive nights, and the `$push` write recorded every finding twice;
 *   - the batch was capped by an UNSORTED `.limit(50)`, so a window holding more than 50
 *     sessions left the surplus permanently unscanned — nothing drained, so the same
 *     candidates could be served again the following night while others were never seen.
 *
 * With the marker the candidate set drains: a scanned session stops matching, so a backlog
 * is worked through one batch per run instead of being invisible. The sort makes which
 * batch deterministic, which an unsorted limit never was.
 *
 * The number of sessions REMAINING is logged rather than only the number processed: a job
 * that reports what it did cannot report what it missed, which is precisely how the
 * retention cron's backlog (B9-③) stayed invisible behind an `Errors: 0`.
 */
const runAntiCheatJob = async () => {
  console.log('[AntiCheatCron] Starting nightly anti-cheat analysis...');

  // Campuses whose Examinations module is not active take no scan at all
  // (design doc §9.1): flagging a submission is a visible verdict issued in the
  // module's name — an emission, not hygiene. Resolved once per run and applied
  // inside both queries, so neither the batch nor the backlog figure counts
  // sessions this job may not touch.
  const excludeCampusIds = await require('../../shared/lib/entitlement').jobs
    .suppressedCampusIds('exam');

  const sessions = await repo.findSessionsPendingAntiCheat(BATCH_SIZE, { excludeCampusIds });

  let totalFlagged = 0;
  let totalPairs   = 0;
  let scanned      = 0;

  for (const s of sessions) {
    // Defensive: the query already selects only unscanned sessions, but the predicate is
    // stated once, in the metric module, and applied on both sides of the boundary.
    if (!shouldRescan(s)) continue;

    try {
      const result = await analyzeSession(s._id);
      totalFlagged += result.flagged;
      totalPairs   += result.pairsChecked;
      scanned      += 1;
    } catch (err) {
      // The session keeps its null marker, so it is retried on the next run rather than
      // being silently dropped from the queue.
      console.error(`[AntiCheatCron] Error analyzing session ${s._id}:`, err.message);
    }
  }

  const remaining = await repo.countSessionsPendingAntiCheat({ excludeCampusIds });

  console.log(
    `[AntiCheatCron] Done. Sessions scanned: ${scanned}/${sessions.length}, `
    + `Pairs: ${totalPairs}, Flagged: ${totalFlagged}, Still pending: ${remaining}`
    + (excludeCampusIds.length ? `, ${excludeCampusIds.length} campus(es) skipped (Examinations not active)` : '')
    + '.'
  );
  return { sessions: scanned, totalPairs, totalFlagged, remaining, suppressedCampuses: excludeCampusIds.length };
};

// ─────────────────────────────────────────────────────────────────────────────

module.exports = { runAntiCheatJob, analyzeSession };
