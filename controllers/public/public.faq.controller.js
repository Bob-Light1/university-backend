'use strict';

/**
 * @file public.faq.controller.js
 * @description FAQ publiée pour un campus (spec §4.11 / §7.6).
 *
 * Route : GET /api/public/faq?campusSlug=...
 * Renvoie les entrées isPublished, triées par order. Contenu bilingue ({fr, en})
 * transmis tel quel — le portail choisit la langue et met en cache 24h.
 */

const Campus   = require('../../models/campus.model');
const FaqEntry = require('../../models/partner-models/faq.entry.model');
const { asyncHandler, sendSuccess, sendError, sendNotFound } = require('../../utils/response-helpers');

const getFaq = asyncHandler(async (req, res) => {
  const { campusSlug } = req.query;

  if (!campusSlug?.trim()) return sendError(res, 400, 'campusSlug is required.');

  const campus = await Campus.findOne({
    campusSlug: campusSlug.toLowerCase().trim(),
    status:     'active',
  }).select('_id').lean();

  if (!campus) return sendNotFound(res, 'Campus');

  const entries = await FaqEntry.find({
    schoolCampus: campus._id,
    isPublished:  true,
  })
    .sort({ order: 1, createdAt: -1 })
    .select('question answer category')
    .lean();

  return sendSuccess(res, 200, 'FAQ retrieved.', { entries });
});

module.exports = { getFaq };
