'use strict';

/**
 * @file public.testimonials.controller.js
 * @description Published testimonials for a campus (spec §4.6 / §7.5).
 *
 * Route: GET /api/public/testimonials?campusSlug=...&limit=6
 * Returns only the isPublished testimonials, sorted by ascending order.
 * Bilingual quote ({fr, en}) passed through as-is — the portal selects the language.
 */

// Lazy require to the campus facade (hub) — see MODULAR_MONOLITH_MIGRATION.md
const campusSvc = () => require('../../../campus').service;
const repo = require('../../public-portal.repository');
const { asyncHandler, sendSuccess, sendError, sendNotFound } = require('../../../../shared/utils/response-helpers');

const DEFAULT_LIMIT = 6;
const MAX_LIMIT     = 50;

const getTestimonials = asyncHandler(async (req, res) => {
  const { campusSlug } = req.query;

  if (!campusSlug?.trim()) return sendError(res, 400, 'campusSlug is required.');

  const campus = await campusSvc().getActiveCampusBySlug(campusSlug.toLowerCase().trim(), '_id');

  if (!campus) return sendNotFound(res, 'Campus');

  const limit = Math.min(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);

  const testimonials = await repo.listPublicTestimonials({ schoolCampus: campus._id, isPublished: true }, limit);

  return sendSuccess(res, 200, 'Testimonials retrieved.', { testimonials });
});

module.exports = { getTestimonials };
