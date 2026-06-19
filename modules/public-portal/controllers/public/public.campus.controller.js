'use strict';

/**
 * @file public.campus.controller.js
 * @description Campus resolution for the public portal.
 *
 * Routes:
 *  GET /api/public/campus-info?ref=PARTNER_CODE   → resolves via partnerCode
 *  GET /api/public/campus-info?slug=CAMPUS_SLUG   → resolves via campusSlug
 *
 * Returns only the public fields — no sensitive data is exposed.
 * The returned campusSlug is used in all subsequent portal calls.
 */

const partnerService = require('../../../partner').service; // partner module facade (§3)
// Lazy require to the campus facade (hub) — see MODULAR_MONOLITH_MIGRATION.md
const campusSvc = () => require('../../../campus').service;

const { asyncHandler, sendSuccess, sendError, sendNotFound } = require('../../../../shared/utils/response-helpers');

// Public fields returned — explicit whitelist
const CAMPUS_PUBLIC_FIELDS = 'campus_name campusSlug campus_image location.city location.country programs nextBatchDate defaultLanguage portalStats';

const getCampusInfo = asyncHandler(async (req, res) => {
  const { ref, slug } = req.query;

  if (!ref && !slug) {
    return sendError(res, 400, 'Provide either ?ref=PARTNER_CODE or ?slug=CAMPUS_SLUG.');
  }

  let campus = null;
  let partnerCode = null;

  if (ref) {
    // Resolution via partnerCode
    const partner = await partnerService.findActivePartnerByCode(ref);

    if (!partner) {
      return sendNotFound(res, 'Partner code');
    }

    partnerCode = partner.partnerCode;
    // status:active filter — consistent with slug resolution; an archived
    // campus must never leak via a still-active partner code.
    campus = await campusSvc().getActiveCampusById(partner.schoolCampus, CAMPUS_PUBLIC_FIELDS);
  } else {
    // Resolution via campusSlug
    campus = await campusSvc().getActiveCampusBySlug(slug.toLowerCase().trim(), CAMPUS_PUBLIC_FIELDS);
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
 * Lists the public campuses (active and with a campusSlug). Used by the portal
 * selection page when a visitor arrives without ?ref or ?slug and the
 * institution has several campuses (spec §3.4).
 */
const listCampuses = asyncHandler(async (req, res) => {
  const campuses = await campusSvc().listActivePublicCampuses(
    'campus_name campusSlug campus_image location.city location.country'
  );

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
