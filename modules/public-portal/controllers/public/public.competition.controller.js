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
const { resolvePortalCampus } = require('../../portal-campus');
const repo = require('../../public-portal.repository');
const { asyncHandler, sendSuccess, sendError } = require('../../../../shared/utils/response-helpers');

const getCompetitionPrizes = asyncHandler(async (req, res) => {
  const { campusSlug } = req.query;

  if (!campusSlug?.trim()) return sendError(res, 400, 'campusSlug is required.');

  // Entitlement-aware resolution (§9.2): a campus whose public portal is
  // hidden answers 404 exactly like one that does not exist.
  const campus = await resolvePortalCampus(res, { slug: campusSlug.toLowerCase().trim(), select: '_id' });
  if (!campus) return;

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
