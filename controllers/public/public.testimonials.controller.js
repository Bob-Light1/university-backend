'use strict';

/**
 * @file public.testimonials.controller.js
 * @description Témoignages publiés pour un campus (spec §4.6 / §7.5).
 *
 * Route : GET /api/public/testimonials?campusSlug=...&limit=6
 * Renvoie uniquement les témoignages isPublished, triés par order croissant.
 * Citation bilingue ({fr, en}) transmise telle quelle — le portail choisit la langue.
 */

const Campus      = require('../../models/campus.model');
const Testimonial = require('../../models/partner-models/testimonial.model');
const { asyncHandler, sendSuccess, sendError, sendNotFound } = require('../../utils/response-helpers');

const DEFAULT_LIMIT = 6;
const MAX_LIMIT     = 50;

const getTestimonials = asyncHandler(async (req, res) => {
  const { campusSlug } = req.query;

  if (!campusSlug?.trim()) return sendError(res, 400, 'campusSlug is required.');

  const campus = await Campus.findOne({
    campusSlug: campusSlug.toLowerCase().trim(),
    status:     'active',
  }).select('_id').lean();

  if (!campus) return sendNotFound(res, 'Campus');

  const limit = Math.min(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);

  const testimonials = await Testimonial.find({
    schoolCampus: campus._id,
    isPublished:  true,
  })
    .sort({ order: 1, createdAt: -1 })
    .limit(limit)
    .select('firstName city graduationYear program quote photoUrl employer')
    .lean();

  return sendSuccess(res, 200, 'Testimonials retrieved.', { testimonials });
});

module.exports = { getTestimonials };
