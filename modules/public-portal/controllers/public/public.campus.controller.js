'use strict';

/**
 * @file public.campus.controller.js
 * @description Résolution campus pour le portail public.
 *
 * Routes :
 *  GET /api/public/campus-info?ref=PARTNER_CODE   → résout via partnerCode
 *  GET /api/public/campus-info?slug=CAMPUS_SLUG   → résout via campusSlug
 *
 * Retourne uniquement les champs publics — aucune donnée sensible exposée.
 * Le campusSlug retourné est utilisé dans tous les appels suivants du portail.
 */

const Partner = require('../../../../models/partner-models/partner.model');
const Campus  = require('../../../../models/campus.model');

const { asyncHandler, sendSuccess, sendError, sendNotFound } = require('../../../../shared/utils/response-helpers');

// Champs publics renvoyés — liste blanche explicite
const CAMPUS_PUBLIC_FIELDS = 'campus_name campusSlug campus_image location.city location.country programs nextBatchDate defaultLanguage portalStats';

const getCampusInfo = asyncHandler(async (req, res) => {
  const { ref, slug } = req.query;

  if (!ref && !slug) {
    return sendError(res, 400, 'Provide either ?ref=PARTNER_CODE or ?slug=CAMPUS_SLUG.');
  }

  let campus = null;
  let partnerCode = null;

  if (ref) {
    // Résolution via partnerCode
    const normalizedCode = ref.toUpperCase().trim();
    const partner = await Partner.findOne({
      partnerCode: normalizedCode,
      status:      'active',
    })
      .select('partnerCode schoolCampus')
      .lean();

    if (!partner) {
      return sendNotFound(res, 'Partner code');
    }

    partnerCode = partner.partnerCode;
    // Filtre status:active — cohérent avec la résolution par slug ; un campus
    // archivé ne doit jamais fuiter via un code partenaire encore actif.
    campus = await Campus.findOne({ _id: partner.schoolCampus, status: 'active' })
      .select(CAMPUS_PUBLIC_FIELDS)
      .lean();
  } else {
    // Résolution via campusSlug
    campus = await Campus.findOne({
      campusSlug: slug.toLowerCase().trim(),
      status:     'active',
    })
      .select(CAMPUS_PUBLIC_FIELDS)
      .lean();
  }

  if (!campus) {
    return sendNotFound(res, 'Campus');
  }

  return sendSuccess(res, 200, 'Campus info retrieved.', {
    campusSlug:    campus.campusSlug,
    campusName:    campus.campus_name,
    logoUrl:       campus.campus_image || null,
    city:          campus.location?.city || null,
    country:       campus.location?.country || null,
    programs:      campus.programs || [],
    nextBatchDate: campus.nextBatchDate || null,
    lang:          campus.defaultLanguage || 'fr',
    stats: {
      studentsTrained:  campus.portalStats?.studentsTrained  ?? null,
      placementRate:    campus.portalStats?.placementRate    ?? null,
      partnerCompanies: campus.portalStats?.partnerCompanies ?? null,
    },
    ...(partnerCode && { partnerCode }),
  });
});

/**
 * GET /api/public/campuses
 *
 * Liste les campus publics (actifs et dotés d'un campusSlug). Utilisé par la page
 * de sélection du portail lorsqu'un visiteur arrive sans ?ref ni ?slug et que
 * l'établissement compte plusieurs campus (spec §3.4).
 */
const listCampuses = asyncHandler(async (req, res) => {
  const campuses = await Campus.find({
    status:     'active',
    campusSlug: { $ne: null },
  })
    .select('campus_name campusSlug campus_image location.city location.country')
    .sort({ campus_name: 1 })
    .lean();

  const data = campuses.map((campus) => ({
    campusSlug: campus.campusSlug,
    campusName: campus.campus_name,
    logoUrl:    campus.campus_image || null,
    city:       campus.location?.city || null,
    country:    campus.location?.country || null,
  }));

  return sendSuccess(res, 200, 'Campuses retrieved.', { campuses: data });
});

module.exports = { getCampusInfo, listCampuses };
