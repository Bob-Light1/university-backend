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

  // Cosine-similarity threshold above which two MCQ answer vectors are flagged.
  antiCheatSimilarityThreshold: 0.85,

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
