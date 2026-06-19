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
const campusSvc = () => require('../../../campus').service;
const repo = require('../../public-portal.repository');
const { asyncHandler, sendSuccess, sendError, sendNotFound } = require('../../../../shared/utils/response-helpers');

const getFaq = asyncHandler(async (req, res) => {
  const { campusSlug } = req.query;

  if (!campusSlug?.trim()) return sendError(res, 400, 'campusSlug is required.');

  const campus = await campusSvc().getActiveCampusBySlug(campusSlug.toLowerCase().trim(), '_id');

  if (!campus) return sendNotFound(res, 'Campus');

  const entries = await repo.listPublicFaq({ schoolCampus: campus._id, isPublished: true });

  return sendSuccess(res, 200, 'FAQ retrieved.', { entries });
});

module.exports = { getFaq };
