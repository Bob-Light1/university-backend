'use strict';

/**
 * @file exam_anticheat.cron.js
 * @description Batch anti-cheat analysis using cosine similarity on MCQ answer vectors.
 *
 *  Triggered manually after ExamSession → COMPLETED, or scheduled nightly.
 *  Computes pairwise cosine similarity for all student MCQ answer vectors within
 *  a session. Pairs exceeding the similarity threshold are flagged for human review
 *  — no automated penalty is applied (detection-only approach per spec §7.3).
 *
 *  Usage in server.js (node-cron):
 *    const cron = require('node-cron');
 *    const { runAntiCheatJob } = require('./crons/exam_anticheat.cron');
 *    cron.schedule('0 3 * * *', runAntiCheatJob); // Nightly at 03:00
 *
 *  Manual trigger (per session):
 *    const { analyzeSession } = require('./crons/exam_anticheat.cron');
 *    await analyzeSession(sessionId);
 */

const mongoose   = require('mongoose');
const ExamSession    = require('../models/exam-models/examSession.model');
const ExamSubmission = require('../models/exam-models/examSubmission.model');
const examConfig     = require('../configs/exam.config');

const SIMILARITY_THRESHOLD = examConfig.antiCheatSimilarityThreshold; // default 0.85
const BATCH_SIZE = 50; // sessions processed per run

// ─── Cosine similarity ────────────────────────────────────────────────────────

/**
 * Build a sparse answer vector for a submission.
 * Vector index = questionId position in questionOrder array.
 * Vector value  = selectedOption (integer) or -1 for unanswered.
 *
 * @param {Array}  answers       submission.answers
 * @param {Array}  questionOrder ordered questionId strings (session canonical order)
 * @returns {number[]}
 */
const _buildVector = (answers, questionOrder) => {
  const map = {};
  for (const a of answers) {
    map[a.questionId.toString()] = a.selectedOption ?? -1;
  }
  return questionOrder.map((qid) => (map[qid] !== undefined ? map[qid] : -1));
};

/**
 * Cosine similarity between two numeric vectors.
 * Returns 0 if either vector is all-zero.
 */
const _cosineSimilarity = (vecA, vecB) => {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i] < 0 ? 0 : vecA[i];
    const b = vecB[i] < 0 ? 0 : vecB[i];
    dot   += a * b;
    normA += a * a;
    normB += b * b;
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

// ─── Per-session analysis ────────────────────────────────────────────────────

/**
 * Runs pairwise cosine similarity analysis for one exam session.
 * Writes suspicion flags to ExamSubmission.antiCheatFlags (append-only).
 * Returns a summary of flagged pairs.
 *
 * @param {string|ObjectId} sessionId
 * @returns {Promise<{ sessionId: string, pairsChecked: number, flagged: number }>}
 */
const analyzeSession = async (sessionId) => {
  if (!mongoose.Types.ObjectId.isValid(sessionId)) {
    return { sessionId: String(sessionId), pairsChecked: 0, flagged: 0 };
  }

  const session = await ExamSession.findById(sessionId).lean();
  if (!session) return { sessionId: String(sessionId), pairsChecked: 0, flagged: 0 };

  // Canonical question order (MCQ only, based on session.questions array)
  const questionOrder = (session.questions || [])
    .map((q) => q.questionId.toString());

  if (!questionOrder.length) {
    return { sessionId: String(sessionId), pairsChecked: 0, flagged: 0 };
  }

  const submissions = await ExamSubmission.find({
    examSession: sessionId,
    status:      { $in: ['SUBMITTED', 'GRADED'] },
    isDeleted:   false,
  }).select('student answers antiCheatFlags').lean();

  if (submissions.length < 2) {
    return { sessionId: String(sessionId), pairsChecked: 0, flagged: 0 };
  }

  // Pre-compute vectors
  const vectors = submissions.map((s) => ({
    submissionId: s._id,
    studentId:    s.student,
    vec:          _buildVector(s.answers || [], questionOrder),
  }));

  let pairsChecked = 0;
  let flagged      = 0;

  // Upper-triangular pairwise comparison — O(n²/2)
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const sim = _cosineSimilarity(vectors[i].vec, vectors[j].vec);
      pairsChecked++;

      if (sim >= SIMILARITY_THRESHOLD) {
        flagged++;
        const simRounded = Math.round(sim * 1000) / 1000;
        const flag = {
          event:     'SIMILARITY_FLAG',
          detail:    `Cosine similarity ${simRounded} >= threshold ${SIMILARITY_THRESHOLD} with student ${vectors[j].studentId}`,
          createdAt: new Date(),
        };
        const flagB = {
          event:     'SIMILARITY_FLAG',
          detail:    `Cosine similarity ${simRounded} >= threshold ${SIMILARITY_THRESHOLD} with student ${vectors[i].studentId}`,
          createdAt: new Date(),
        };

        // Append flags — non-blocking, fire-and-forget per pair
        await Promise.all([
          ExamSubmission.findByIdAndUpdate(vectors[i].submissionId, {
            $push: { antiCheatFlags: flag },
          }),
          ExamSubmission.findByIdAndUpdate(vectors[j].submissionId, {
            $push: { antiCheatFlags: flagB },
          }),
        ]);
      }
    }
  }

  console.log(
    `[AntiCheatCron] Session ${sessionId}: ${pairsChecked} pairs checked, ${flagged} flagged (threshold ${SIMILARITY_THRESHOLD}).`
  );
  return { sessionId: String(sessionId), pairsChecked, flagged };
};

// ─── Nightly batch job ────────────────────────────────────────────────────────

/**
 * Processes all recently-completed sessions that have not yet been scanned.
 * "Not yet scanned" = sessions completed in the last 48 h.
 * Runs in batches of BATCH_SIZE to avoid memory pressure.
 */
const runAntiCheatJob = async () => {
  console.log('[AntiCheatCron] Starting nightly anti-cheat analysis...');

  const since = new Date(Date.now() - 48 * 60 * 60 * 1000);

  const sessions = await ExamSession.find({
    status:      'COMPLETED',
    completedAt: { $gte: since },
    isDeleted:   false,
  })
    .select('_id')
    .limit(BATCH_SIZE)
    .lean();

  let totalFlagged = 0;
  let totalPairs   = 0;

  for (const s of sessions) {
    try {
      const result = await analyzeSession(s._id);
      totalFlagged += result.flagged;
      totalPairs   += result.pairsChecked;
    } catch (err) {
      console.error(`[AntiCheatCron] Error analyzing session ${s._id}:`, err.message);
    }
  }

  console.log(
    `[AntiCheatCron] Done. Sessions: ${sessions.length}, Pairs: ${totalPairs}, Flagged: ${totalFlagged}.`
  );
  return { sessions: sessions.length, totalPairs, totalFlagged };
};

// ─────────────────────────────────────────────────────────────────────────────

module.exports = { runAntiCheatJob, analyzeSession };
