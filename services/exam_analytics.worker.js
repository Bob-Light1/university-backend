'use strict';

/**
 * @file exam_analytics.worker.js
 * @description Async analytics snapshot worker for SEMS.
 *
 *  Listens for 'examAnalytics:compute' events emitted after grade publication
 *  or session completion. Computes and upserts ExamAnalyticsSnapshot.
 *  Never blocks an HTTP response.
 *
 *  Usage (from controllers):
 *    const { examAnalyticsWorker } = require('../../services/exam_analytics.worker');
 *    examAnalyticsWorker.emit('examAnalytics:compute', sessionId);
 */

const EventEmitter = require('events');
const mongoose     = require('mongoose');

const ExamAnalyticsSnapshot = require('../models/exam-models/examAnalyticsSnapshot.model');
const ExamGrading           = require('../models/exam-models/examGrading.model');
const ExamEnrollment        = require('../models/exam-models/examEnrollment.model');
const ExamSession           = require('../models/exam-models/examSession.model');
const examConfig            = require('../configs/exam.config');

const examAnalyticsWorker = new EventEmitter();

// ─── Compute snapshot ─────────────────────────────────────────────────────────

const _computeSnapshot = async (sessionId) => {
  if (!mongoose.Types.ObjectId.isValid(sessionId)) return;

  const session = await ExamSession.findById(sessionId);
  if (!session) return;

  const publishedGradings = await ExamGrading.find({
    examSession: sessionId,
    status:      'PUBLISHED',
    isDeleted:   false,
  }).select('normalizedScore student examSession schoolCampus');

  if (!publishedGradings.length) return;

  const scores = publishedGradings.map((g) => g.normalizedScore ?? 0).sort((a, b) => a - b);
  const count  = scores.length;
  const mean   = scores.reduce((s, v) => s + v, 0) / count;

  // Median
  const mid    = Math.floor(count / 2);
  const median = count % 2 === 0 ? (scores[mid - 1] + scores[mid]) / 2 : scores[mid];

  // Standard deviation
  const variance = scores.reduce((s, v) => s + (v - mean) ** 2, 0) / count;
  const stdDev   = Math.sqrt(variance);

  const min = scores[0];
  const max = scores[count - 1];

  // Passing rate (>= 10 / 20)
  const passMark   = 10;
  const passCount  = scores.filter((s) => s >= passMark).length;
  const passingRate = Math.round((passCount / count) * 100 * 10) / 10;

  // Score distribution — 10 buckets 0–20
  const buckets = examConfig.distributionBuckets;
  const step    = 20 / buckets;
  const distribution = Array.from({ length: buckets }, (_, i) => {
    const lo  = i * step;
    const hi  = lo + step;
    const cnt = scores.filter((s) => s >= lo && (i === buckets - 1 ? s <= hi : s < hi)).length;
    return { range: `${lo.toFixed(0)}-${hi.toFixed(0)}`, count: cnt };
  });

  // Item analysis — MCQ only
  const ExamSubmission = require('../models/exam-models/examSubmission.model');
  const submissions    = await ExamSubmission.find({
    examSession: sessionId,
    status:      { $in: ['SUBMITTED', 'GRADED'] },
    isDeleted:   false,
  }).select('answers student');

  const questionRefs   = session.questions || [];
  const QuestionBank   = require('../models/exam-models/questionBank.model');
  const mcqQuestions   = await QuestionBank.find({
    _id:          { $in: questionRefs.map((q) => q.questionId) },
    questionType: 'MCQ',
  }).select('options bloomLevel difficulty');

  const itemAnalysis = [];
  for (const q of mcqQuestions) {
    const correctIdx = (q.options || []).findIndex((o) => o.isCorrect);
    if (correctIdx < 0) continue;

    const attempts      = submissions.filter((s) => s.answers.some((a) => a.questionId.toString() === q._id.toString()));
    const correctCount  = attempts.filter((s) => {
      const ans = s.answers.find((a) => a.questionId.toString() === q._id.toString());
      return ans?.selectedOption === correctIdx;
    }).length;

    const difficultyIndex     = attempts.length ? Math.round((correctCount / attempts.length) * 100) / 100 : 0;
    // Simple discrimination: top vs bottom 27%
    const topN    = Math.max(1, Math.floor(count * 0.27));
    const sorted  = publishedGradings.sort((a, b) => (b.normalizedScore ?? 0) - (a.normalizedScore ?? 0));
    const topIds  = new Set(sorted.slice(0, topN).map((g) => g.student.toString()));
    const botIds  = new Set(sorted.slice(-topN).map((g) => g.student.toString()));
    const topSubs = submissions.filter((s) => topIds.has(s.student.toString()));
    const botSubs = submissions.filter((s) => botIds.has(s.student.toString()));
    const topCorr = topSubs.filter((s) => {
      const ans = s.answers.find((a) => a.questionId.toString() === q._id.toString());
      return ans?.selectedOption === correctIdx;
    }).length;
    const botCorr = botSubs.filter((s) => {
      const ans = s.answers.find((a) => a.questionId.toString() === q._id.toString());
      return ans?.selectedOption === correctIdx;
    }).length;
    const discriminationIndex = topSubs.length && botSubs.length
      ? Math.round(((topCorr / topSubs.length) - (botCorr / botSubs.length)) * 100) / 100
      : 0;

    itemAnalysis.push({
      questionId:          q._id,
      difficultyIndex,
      discriminationIndex,
      bloomLevel:          q.bloomLevel,
    });

    // Update psychometric fields on the question itself
    await QuestionBank.findByIdAndUpdate(q._id, {
      $set: { difficultyIndex, discriminationIdx: discriminationIndex },
    });
  }

  // EWS dropout risk (reuses the same formula as earlyWarning endpoint)
  const atRisk = publishedGradings.filter((g) => (g.normalizedScore ?? 0) < 8).length;
  const failRate = count ? atRisk / count : 0;
  const dropoutRiskScore = Math.min(100, Math.round((failRate * 60 + (10 - Math.min(mean, 10)) * 4) * 10) / 10);

  // Absent count
  const absentCount = await ExamEnrollment.countDocuments({
    examSession: sessionId,
    attendance:  'ABSENT',
    isDeleted:   false,
  });

  await ExamAnalyticsSnapshot.findOneAndUpdate(
    { examSession: sessionId },
    {
      $set: {
        schoolCampus:     session.schoolCampus,
        examSession:      sessionId,
        count,
        mean:             Math.round(mean   * 100) / 100,
        median:           Math.round(median * 100) / 100,
        stdDev:           Math.round(stdDev * 100) / 100,
        min,
        max,
        passingRate,
        distribution,
        itemAnalysis,
        dropoutRiskScore,
        atRiskCount:      atRisk,
        absentCount,
        computedAt:       new Date(),
      },
    },
    { upsert: true, new: true }
  );

  console.log(`✅ [SEMS Analytics] Snapshot computed for session ${sessionId}.`);
};

// ─── Event listener ───────────────────────────────────────────────────────────

examAnalyticsWorker.on('examAnalytics:compute', (sessionId) => {
  _computeSnapshot(sessionId).catch((err) => {
    console.error(`❌ [SEMS Analytics] Failed for session ${sessionId}:`, err.message);
  });
});

module.exports = { examAnalyticsWorker };
