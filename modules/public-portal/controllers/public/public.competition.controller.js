'use strict';

/**
 * @file public.competition.controller.js
 * @description Prizes of the current monthly competition (spec §4.5 / §7.8).
 *
 * Route: GET /api/public/competition/prizes?campusSlug=...
 * Returns the campus's active competition: prize tiers + closingDate (for the
 * portal-side countdown). Winners are only populated after closing by the
 * cron — exposed in anonymized form (displayName + score + rank only, never
 * the lead/quizSession references).
 */

// Lazy require to the campus facade (hub) — see MODULAR_MONOLITH_MIGRATION.md
const campusSvc = () => require('../../../campus').service;
const repo = require('../../public-portal.repository');
const { asyncHandler, sendSuccess, sendError, sendNotFound } = require('../../../../shared/utils/response-helpers');

const getCompetitionPrizes = asyncHandler(async (req, res) => {
  const { campusSlug } = req.query;

  if (!campusSlug?.trim()) return sendError(res, 400, 'campusSlug is required.');

  const campus = await campusSvc().getActiveCampusBySlug(campusSlug.toLowerCase().trim(), '_id');

  if (!campus) return sendNotFound(res, 'Campus');

  // Most recent active competition for this campus
  const competition = await repo.findActivePublicCompetition({
    schoolCampus: campus._id,
    isActive:     true,
  });

  if (!competition) {
    // No competition in progress — empty but valid response (the portal hides the section)
    return sendSuccess(res, 200, 'No active competition.', { competition: null });
  }

  // Anonymization of winners — never the internal references
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
