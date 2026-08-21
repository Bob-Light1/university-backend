'use strict';

/**
 * @file public.faq.controller.js
 * @description Published FAQ for a campus (spec §4.11 / §7.6).
 *
 * Route: GET /api/public/faq?campusSlug=...
 * Returns the isPublished entries, sorted by order. Bilingual content ({fr, en})
 * passed through as-is — the portal chooses the language and caches for 24h.
 */

// Lazy require to the campus facade (hub) — see MODULAR_MONOLITH_MIGRATION.md
const { resolvePortalCampus } = require('../../portal-campus');
const repo = require('../../public-portal.repository');
const { asyncHandler, sendSuccess, sendError } = require('../../../../shared/utils/response-helpers');

const getFaq = asyncHandler(async (req, res) => {
  const { campusSlug } = req.query;

  if (!campusSlug?.trim()) return sendError(res, 400, 'campusSlug is required.');

  // Entitlement-aware resolution (§9.2): a campus whose public portal is
  // hidden answers 404 exactly like one that does not exist.
  const campus = await resolvePortalCampus(res, { slug: campusSlug.toLowerCase().trim(), select: '_id' });
  if (!campus) return;

  const entries = await repo.listPublicFaq({ schoolCampus: campus._id, isPublished: true });

  return sendSuccess(res, 200, 'FAQ retrieved.', { entries });
});

module.exports = { getFaq };
