'use strict';

/**
 * @file public.leaderboard.controller.js
 * @description Classement mensuel des scores de quiz.
 *
 * Route : GET /api/public/leaderboard?campusSlug=...&period=YYYY-MM&category=...&scope=campus|national
 *
 * Limites :
 *  - scope=campus   → top 50 par campus
 *  - scope=national → top 20 toutes campus confondues
 *
 * Données exposées : displayName, city, country, score, category, period.
 * Aucune donnée personnelle (email, téléphone, IP) n'est exposée.
 */

const mongoose     = require('mongoose');
const QuizSession  = require('../../models/partner-models/quiz.session.model');
const Campus       = require('../../models/campus.model');

const { asyncHandler, sendSuccess, sendError, sendNotFound } = require('../../utils/response-helpers');

const getLeaderboard = asyncHandler(async (req, res) => {
  const {
    campusSlug,
    period,
    category,
    scope = 'campus',
  } = req.query;

  // period par défaut = mois courant
  const now            = new Date();
  const currentPeriod  = period?.match(/^\d{4}-\d{2}$/)
    ? period
    : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const filter = {
    period:      currentPeriod,
    completedAt: { $ne: null },
  };

  let campusId = null;

  if (scope === 'campus' || campusSlug?.trim()) {
    if (!campusSlug?.trim()) {
      return sendError(res, 400, 'campusSlug is required for campus scope.');
    }

    const campus = await Campus.findOne({
      campusSlug: campusSlug.toLowerCase().trim(),
      status:     'active',
    }).select('_id').lean();

    if (!campus) return sendNotFound(res, 'Campus');

    campusId             = campus._id;
    filter.schoolCampus  = campusId;
  }

  if (category?.trim()) {
    filter.category = category.toLowerCase().trim();
  }

  const limit = scope === 'national' ? 20 : 50;

  const entries = await QuizSession.find(filter)
    .sort({ score: -1, completedAt: 1 })
    .limit(limit)
    .select('displayName city country score category period completedAt')
    .lean();

  const ranked = entries.map((entry, idx) => ({
    rank:        idx + 1,
    displayName: entry.displayName || 'Anonyme',
    city:        entry.city || null,
    country:     entry.country || null,
    score:       entry.score,
    category:    entry.category,
    completedAt: entry.completedAt,
  }));

  return sendSuccess(res, 200, 'Leaderboard retrieved.', {
    period:     currentPeriod,
    scope,
    category:   category?.toLowerCase() || null,
    campusSlug: campusSlug?.toLowerCase() || null,
    total:      ranked.length,
    entries:    ranked,
  });
});

module.exports = { getLeaderboard };
