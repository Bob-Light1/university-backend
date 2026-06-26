'use strict';

/**
 * @file public.programs.controller.js
 * @description List of programs available for a campus.
 *
 * Route: GET /api/public/programs?campusSlug=...
 * Used by the pre-registration form to populate the program dropdown.
 */

// Lazy require to the campus facade (hub) — see MODULAR_MONOLITH_MIGRATION.md
const campusSvc = () => require('../../../campus').service;
const { asyncHandler, sendSuccess, sendError, sendNotFound } = require('../../../../shared/utils/response-helpers');

const getPrograms = asyncHandler(async (req, res) => {
  const { campusSlug } = req.query;

  if (!campusSlug?.trim()) return sendError(res, 400, 'campusSlug is required.');

  const campus = await campusSvc().getActiveCampusBySlug(campusSlug.toLowerCase().trim(), 'programs campus_name');

  if (!campus) return sendNotFound(res, 'Campus');

  return sendSuccess(res, 200, 'Programs retrieved.', {
    campusName: campus.campus_name,
    programs:   campus.programs || [],
  });
});

module.exports = { getPrograms };
