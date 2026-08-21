'use strict';

/**
 * @file public.programs.controller.js
 * @description List of programs available for a campus.
 *
 * Route: GET /api/public/programs?campusSlug=...
 * Used by the pre-registration form to populate the program dropdown.
 */

// Lazy require to the campus facade (hub) — see MODULAR_MONOLITH_MIGRATION.md
const { resolvePortalCampus } = require('../../portal-campus');
const { asyncHandler, sendSuccess, sendError } = require('../../../../shared/utils/response-helpers');

const getPrograms = asyncHandler(async (req, res) => {
  const { campusSlug } = req.query;

  if (!campusSlug?.trim()) return sendError(res, 400, 'campusSlug is required.');

  // Entitlement-aware resolution (§9.2): a campus whose public portal is
  // hidden answers 404 exactly like one that does not exist.
  const campus = await resolvePortalCampus(res, { slug: campusSlug.toLowerCase().trim(), select: 'programs campus_name' });
  if (!campus) return;

  return sendSuccess(res, 200, 'Programs retrieved.', {
    campusName: campus.campus_name,
    programs:   campus.programs || [],
  });
});

module.exports = { getPrograms };
