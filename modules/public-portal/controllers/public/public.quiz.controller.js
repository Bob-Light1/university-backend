'use strict';

/**
 * @file public.quiz.controller.js
 * @description Quiz public — récupération des questions et soumission des réponses.
 *
 * Routes :
 *  GET  /api/public/quiz?campusSlug=...&category=...&limit=10&lang=fr
 *  POST /api/public/quiz/submit
 *
 * Sécurité :
 *  - correctIndex est select:false — jamais inclus dans les questions envoyées
 *  - Le score est calculé entièrement côté ERP
 *  - Le portail reçoit le score final mais jamais les correctIndex
 *
 * sessionToken : UUID généré côté portail, transmis dans la soumission.
 * period        : 'YYYY-MM' calculé depuis la date de soumission.
 */

const mongoose    = require('mongoose');
const QuizQuestion = require('../../models/quiz.question.model');
const QuizSession  = require('../../models/quiz.session.model');
const Campus       = require('../../../../models/campus.model');

const { asyncHandler, sendSuccess, sendError, sendNotFound } = require('../../../../shared/utils/response-helpers');

// ── GET QUESTIONS ─────────────────────────────────────────────────────────────

const getQuizQuestions = asyncHandler(async (req, res) => {
  const { campusSlug, category, lang = 'fr', limit = '10' } = req.query;

  if (!campusSlug?.trim()) return sendError(res, 400, 'campusSlug is required.');

  const campus = await Campus.findOne({
    campusSlug: campusSlug.toLowerCase().trim(),
    status:     'active',
  }).select('_id').lean();

  if (!campus) return sendNotFound(res, 'Campus');

  const filter = {
    schoolCampus: campus._id,
    isPublished:  true,
  };
  if (category?.trim()) filter.category = category.toLowerCase().trim();
  if (['fr', 'en'].includes(lang)) filter.lang = lang;

  const limitNum = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 20);

  // Agrégation $sample pour randomiser. L'agrégation NE respecte PAS select:false,
  // donc on passe par une liste blanche explicite : correctIndex et tout champ
  // interne (schoolCampus, isPublished, timestamps) restent côté ERP.
  const questions = await QuizQuestion.aggregate([
    { $match: filter },
    { $sample: { size: limitNum } },
    { $project: { _id: 1, text: 1, options: 1, category: 1, difficulty: 1, lang: 1 } },
  ]);

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

  const campus = await Campus.findOne({
    campusSlug: campusSlug.toLowerCase().trim(),
    status:     'active',
  }).select('_id programs').lean();

  if (!campus) return sendNotFound(res, 'Campus');

  // Vérifier qu'une session avec ce token n'existe pas déjà (évite double soumission)
  const existingSession = await QuizSession.findOne({ sessionToken }).lean();
  if (existingSession) {
    return sendError(res, 409, 'This quiz session has already been submitted.');
  }

  // Dédupliquer les réponses par questionId — anti-gaming : empêche qu'une même
  // question soumise plusieurs fois ne gonfle correctAnswers au-delà du total
  // (ce qui produisait un score > 100 et un échec de validation Mongoose).
  const answerMap = new Map(); // questionId → selectedIndex (première occurrence)
  for (const a of answers) {
    if (a && mongoose.Types.ObjectId.isValid(a.questionId) && !answerMap.has(String(a.questionId))) {
      answerMap.set(String(a.questionId), a.selectedIndex);
    }
  }

  const questionIds = [...answerMap.keys()];
  if (questionIds.length === 0) {
    return sendError(res, 400, 'No valid questionId values provided.');
  }

  const questions = await QuizQuestion.find({
    _id:          { $in: questionIds.map((id) => new mongoose.Types.ObjectId(id)) },
    schoolCampus: campus._id,
    isPublished:  true,
  })
    .select('+correctIndex')
    .lean();

  if (questions.length === 0) {
    return sendError(res, 404, 'No valid published questions found for these IDs.');
  }

  // Calculer le score sur les seules questions valides et publiées du campus.
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

  const session = new QuizSession({
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

  await session.save();

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
