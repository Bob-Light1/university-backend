'use strict';

/**
 * @file public.courses.controller.js
 * @description Aperçus de cours publiés pour un campus (spec §4.7).
 *
 * Route : GET /api/public/course-previews?campusSlug=...&program=...
 * Renvoie les extraits isPublished, triés par order. Contenu bilingue ({fr, en})
 * transmis tel quel. Filtre optionnel par program.
 *
 * NOTE : endpoint Phase 2 non détaillé dans la spec §7 — à valider avec le responsable projet.
 */

// Require paresseux vers la facade campus (hub) — voir MODULAR_MONOLITH_MIGRATION.md
const campusSvc = () => require('../../../campus').service;
const CoursePreview = require('../../models/course.preview.model');
const { asyncHandler, sendSuccess, sendError, sendNotFound } = require('../../../../shared/utils/response-helpers');

const getCoursePreviews = asyncHandler(async (req, res) => {
  const { campusSlug, program } = req.query;

  if (!campusSlug?.trim()) return sendError(res, 400, 'campusSlug is required.');

  const campus = await campusSvc().getActiveCampusBySlug(campusSlug.toLowerCase().trim(), '_id');

  if (!campus) return sendNotFound(res, 'Campus');

  const filter = { schoolCampus: campus._id, isPublished: true };
  if (program?.trim()) filter.program = program.trim();

  const previews = await CoursePreview.find(filter)
    .sort({ order: 1, createdAt: -1 })
    .select('program title content videoUrl')
    .lean();

  return sendSuccess(res, 200, 'Course previews retrieved.', { previews });
});

module.exports = { getCoursePreviews };
