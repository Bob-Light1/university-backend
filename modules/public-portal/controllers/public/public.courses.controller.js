'use strict';

/**
 * @file public.courses.controller.js
 * @description Published course previews for a campus (spec §4.7).
 *
 * Route: GET /api/public/course-previews?campusSlug=...&program=...
 * Returns the isPublished excerpts, sorted by order. Bilingual content ({fr, en})
 * passed through as-is. Optional filter by program.
 *
 * NOTE: Phase 2 endpoint not detailed in spec §7 — to be validated with the project lead.
 */

// Lazy require to the campus facade (hub) — see MODULAR_MONOLITH_MIGRATION.md
const { resolvePortalCampus } = require('../../portal-campus');
const repo = require('../../public-portal.repository');
const { asyncHandler, sendSuccess, sendError } = require('../../../../shared/utils/response-helpers');

const getCoursePreviews = asyncHandler(async (req, res) => {
  const { campusSlug, program } = req.query;

  if (!campusSlug?.trim()) return sendError(res, 400, 'campusSlug is required.');

  // Entitlement-aware resolution (§9.2): a campus whose public portal is
  // hidden answers 404 exactly like one that does not exist.
  const campus = await resolvePortalCampus(res, { slug: campusSlug.toLowerCase().trim(), select: '_id' });
  if (!campus) return;

  const filter = { schoolCampus: campus._id, isPublished: true };
  if (program?.trim()) filter.program = program.trim();

  const previews = await repo.listPublicCoursePreviews(filter);

  return sendSuccess(res, 200, 'Course previews retrieved.', { previews });
});

module.exports = { getCoursePreviews };
