'use strict';

/**
 * @file public.competition.controller.js
 * @description Prix de la compétition mensuelle en cours (spec §4.5 / §7.8).
 *
 * Route : GET /api/public/competition/prizes?campusSlug=...
 * Renvoie la compétition active du campus : barème des prix + closingDate (pour le
 * countdown côté portail). Les gagnants (winners) ne sont peuplés qu'après clôture par
 * le cron — exposés sous forme anonymisée (displayName + score + rank uniquement, jamais
 * les références lead/quizSession).
 */

// Require paresseux vers la facade campus (hub) — voir MODULAR_MONOLITH_MIGRATION.md
const campusSvc = () => require('../../../campus').service;
const CompetitionPrize = require('../../models/competition.prize.model');
const { asyncHandler, sendSuccess, sendError, sendNotFound } = require('../../../../shared/utils/response-helpers');

const getCompetitionPrizes = asyncHandler(async (req, res) => {
  const { campusSlug } = req.query;

  if (!campusSlug?.trim()) return sendError(res, 400, 'campusSlug is required.');

  const campus = await campusSvc().getActiveCampusBySlug(campusSlug.toLowerCase().trim(), '_id');

  if (!campus) return sendNotFound(res, 'Campus');

  // Compétition active la plus récente pour ce campus
  const competition = await CompetitionPrize.findOne({
    schoolCampus: campus._id,
    isActive:     true,
  })
    .sort({ period: -1 })
    .select('period prizes closingDate winners')
    .lean();

  if (!competition) {
    // Pas de compétition en cours — réponse vide mais valide (le portail masque la section)
    return sendSuccess(res, 200, 'No active competition.', { competition: null });
  }

  // Anonymisation des gagnants — jamais les références internes
  const winners = (competition.winners || []).map((w) => ({
    rank:        w.rank,
    displayName: w.displayName,
    score:       w.score,
  }));

  return sendSuccess(res, 200, 'Competition prizes retrieved.', {
    competition: {
      period:      competition.period,
      prizes:      competition.prizes || [],
      closingDate: competition.closingDate,
      winners,
    },
  });
});

module.exports = { getCompetitionPrizes };
