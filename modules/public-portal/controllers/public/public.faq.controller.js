'use strict';

/**
 * @file public.faq.controller.js
 * @description FAQ publiée pour un campus (spec §4.11 / §7.6).
 *
 * Route : GET /api/public/faq?campusSlug=...
 * Renvoie les entrées isPublished, triées par order. Contenu bilingue ({fr, en})
 * transmis tel quel — le portail choisit la langue et met en cache 24h.
 */

// Require paresseux vers la facade campus (hub) — voir MODULAR_MONOLITH_MIGRATION.md
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
