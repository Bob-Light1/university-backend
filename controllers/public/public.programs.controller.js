'use strict';

/**
 * @file public.programs.controller.js
 * @description Liste des formations disponibles pour un campus.
 *
 * Route : GET /api/public/programs?campusSlug=...
 * Utilisé dans le formulaire de pré-inscription pour alimenter le dropdown.
 */

const Campus = require('../../models/campus.model');
const { asyncHandler, sendSuccess, sendError, sendNotFound } = require('../../utils/response-helpers');

const getPrograms = asyncHandler(async (req, res) => {
  const { campusSlug } = req.query;

  if (!campusSlug?.trim()) return sendError(res, 400, 'campusSlug is required.');

  const campus = await Campus.findOne({
    campusSlug: campusSlug.toLowerCase().trim(),
    status:     'active',
  }).select('programs campus_name').lean();

  if (!campus) return sendNotFound(res, 'Campus');

  return sendSuccess(res, 200, 'Programs retrieved.', {
    campusName: campus.campus_name,
    programs:   campus.programs || [],
  });
});

module.exports = { getPrograms };
