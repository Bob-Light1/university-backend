'use strict';

/**
 * @file public.testimonials.controller.js
 * @description Témoignages publiés pour un campus (spec §4.6 / §7.5).
 *
 * Route : GET /api/public/testimonials?campusSlug=...&limit=6
 * Renvoie uniquement les témoignages isPublished, triés par order croissant.
 * Citation bilingue ({fr, en}) transmise telle quelle — le portail choisit la langue.
 */

// Require paresseux vers la facade campus (hub) — voir MODULAR_MONOLITH_MIGRATION.md
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
