'use strict';

/**
 * @file exam.config.js
 * @description SEMS — campus-level configuration constants.
 *
 *  Every value here is a platform default. Per-campus overrides can be stored
 *  on the Campus model (campus.examConfig sub-document) and read at runtime.
 */

module.exports = {
  // Days after grade publication during which students may file an appeal.
  appealWindowDays: 7,

  // /20-scale discrepancy threshold that triggers needsMediation on ExamGrading.
  gradingDiscrepancyThreshold: 3,

  // Answer-agreement ratio at or above which two MCQ papers are flagged for human review.
  // This is the fraction of COMMONLY-ANSWERED questions the two students answered
  // identically — an equality count over option labels, not a geometric measure. It
  // replaced a cosine similarity, which rated two papers sharing zero answers at 1.0 and
  // two identical all-option-0 papers at 0.0 (see exam-anticheat.metric.js).
  antiCheatAgreementThreshold: 0.85,

  // Floor on the DENOMINATOR of that ratio. Without it, two students who each answered only
  // two questions and agree on both score a perfect 1.0 and outrank a pair agreeing on 47
  // of 50. A threshold on a ratio needs a floor on the sample it came from.
  antiCheatMinCommonAnswers: 5,

  // Sessions scanned per nightly run. The candidate set drains (a scanned session stops
  // matching), so a backlog larger than one batch is picked up on the following run.
  antiCheatBatchSize: 50,

  // Default exam duration in minutes when not specified on the session.
  defaultDurationMinutes: 90,

  // Maximum questions allowed per exam session.
  maxQuestionsPerSession: 200,

  // Maximum questions a single QuestionBank entry can appear in (usageCount cap).
  maxQuestionUsageCount: 50,

  // Score distribution bucket count for ExamAnalyticsSnapshot.
  distributionBuckets: 10,

  // EWS individual risk threshold: students at or above this are flagged.
  ewsRiskThreshold: 60,
};
