'use strict';

/**
 * @file public.quiz.controller.js
 * @description Public quiz — fetching questions and submitting answers.
 *
 * Routes:
 *  GET  /api/public/quiz?campusSlug=...&category=...&limit=10&lang=fr
 *  POST /api/public/quiz/submit
 *
 * Security:
 *  - correctIndex is select:false — never included in the questions sent
 *  - The score is computed entirely on the ERP side
 *  - The portal receives the final score but never the correctIndex
 *
 * sessionToken: UUID generated on the portal side, passed in the submission.
 * period       : 'YYYY-MM' computed from the submission date.
 */

const mongoose    = require('mongoose'); // kept for ObjectId cast/validation
const repo        = require('../../public-portal.repository');
// Lazy require to the campus facade (hub) — see MODULAR_MONOLITH_MIGRATION.md
const campusSvc = () => require('../../../campus').service;

const { asyncHandler, sendSuccess, sendError, sendNotFound } = require('../../../../shared/utils/response-helpers');

// ── GET QUESTIONS ─────────────────────────────────────────────────────────────

const getQuizQuestions = asyncHandler(async (req, res) => {
  const { campusSlug, category, lang = 'fr', limit = '10' } = req.query;

  if (!campusSlug?.trim()) return sendError(res, 400, 'campusSlug is required.');

  const campus = await campusSvc().getActiveCampusBySlug(campusSlug.toLowerCase().trim(), '_id');

  if (!campus) return sendNotFound(res, 'Campus');

  const filter = {
    schoolCampus: campus._id,
    isPublished:  true,
  };
  if (category?.trim()) filter.category = category.toLowerCase().trim();
  if (['fr', 'en'].includes(lang)) filter.lang = lang;

  const limitNum = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 20);

  // $sample aggregation to randomize. The aggregation does NOT respect select:false,
  // so we go through an explicit whitelist: correctIndex and every internal
  // field (schoolCampus, isPublished, timestamps) stay on the ERP side.
  const questions = await repo.sampleQuizQuestions(filter, limitNum);

  return sendSuccess(res, 200, 'Quiz questions retrieved.', {
    campusSlug: campusSlug.toLowerCase().trim(),
    category:   category?.toLowerCase() || null,
    lang,
    questions,
  });
});

// ── SUBMIT QUIZ ───────────────────────────────────────────────────────────────

const submitQuiz = asyncHandler(async (req, res) => {
  const {
    campusSlug,
    sessionToken,
    category,
    answers,          // [{ questionId, selectedIndex }]
    displayName,
    city,
    country,
    partnerCode,
  } = req.body;

  if (!campusSlug?.trim())    return sendError(res, 400, 'campusSlug is required.');
  if (!sessionToken?.trim())  return sendError(res, 400, 'sessionToken is required.');
  if (!Array.isArray(answers) || answers.length === 0) {
    return sendError(res, 400, 'answers must be a non-empty array.');
  }

  const campus = await campusSvc().getActiveCampusBySlug(campusSlug.toLowerCase().trim(), '_id programs');

  if (!campus) return sendNotFound(res, 'Campus');

  // Check that no session with this token already exists (prevents double submission)
  const existingSession = await repo.findQuizSessionByToken(sessionToken);
  if (existingSession) {
    return sendError(res, 409, 'This quiz session has already been submitted.');
  }

  // Deduplicate answers by questionId — anti-gaming: prevents the same
  // question submitted several times from inflating correctAnswers beyond the total
  // (which produced a score > 100 and a Mongoose validation failure).
  const answerMap = new Map(); // questionId → selectedIndex (first occurrence)
  for (const a of answers) {
    if (a && mongoose.Types.ObjectId.isValid(a.questionId) && !answerMap.has(String(a.questionId))) {
      answerMap.set(String(a.questionId), a.selectedIndex);
    }
  }

  const questionIds = [...answerMap.keys()];
  if (questionIds.length === 0) {
    return sendError(res, 400, 'No valid questionId values provided.');
  }

  const questions = await repo.findPublishedQuestionsWithAnswers({
    _id:          { $in: questionIds.map((id) => new mongoose.Types.ObjectId(id)) },
    schoolCampus: campus._id,
    isPublished:  true,
  });

  if (questions.length === 0) {
    return sendError(res, 404, 'No valid published questions found for these IDs.');
  }

  // Compute the score on only the valid, published questions of the campus.
  let correctAnswers = 0;
  for (const q of questions) {
    const selectedIndex = answerMap.get(String(q._id));
    if (typeof selectedIndex === 'number' && selectedIndex === q.correctIndex) {
      correctAnswers++;
    }
  }

  const totalQuestions = questions.length;
  const score          = Math.round((correctAnswers / totalQuestions) * 100);

  const now    = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const session = await repo.createQuizSession({
    schoolCampus:   campus._id,
    partnerCode:    partnerCode?.toUpperCase().trim() || null,
    sessionToken:   sessionToken.trim(),
    displayName:    displayName?.trim() || null,
    city:           city?.trim() || null,
    country:        country?.trim() || null,
    category:       category?.toLowerCase().trim() || 'general',
    score,
    correctAnswers,
    totalQuestions,
    completedAt:    now,
    ipAddressHash:  req.ipHash,
    period,
  });

  // For placement tests, map score to a campus program recommendation.
  let recommendedProgram = null;
  if (category?.toLowerCase().trim() === 'placement' && campus.programs?.length) {
    const programs = campus.programs;
    const idx = Math.min(
      Math.floor((score / 100) * programs.length),
      programs.length - 1,
    );
    recommendedProgram = programs[idx];
  }

  return sendSuccess(res, 201, 'Quiz submitted successfully.', {
    sessionId:         session._id,
    score,
    correctAnswers,
    totalQuestions,
    period,
    recommendedProgram,
  });
});

module.exports = { getQuizQuestions, submitQuiz };
