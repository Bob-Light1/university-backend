'use strict';

/**
 * @file partner.application.admin.controller.js
 * @description Authenticated review of PartnerApplication records (spec §4.9).
 *
 * Admins list, review, approve, or reject partner applications.
 * Approval does NOT auto-create a Partner record — the admin does that manually
 * after reviewing; this controller just sets status + partnerId reference.
 */

const partnerService = require('../../../partner').service; // façade module partner (§3)
const {
  buildCampusFilter,
  GLOBAL_ROLES,
} = require('./portal-admin.factory');
const {
  sendSuccess,
  sendError,
  sendPaginated,
  sendNotFound,
} = require('../../../../shared/utils/response-helpers');
const { isValidObjectId } = require('../../../../utils/validation-helpers');

// ─── LIST ─────────────────────────────────────────────────────────────────────
const list = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, campusId } = req.query;
    const safePage  = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));

    const campusFilter = { ...buildCampusFilter(req.user) };
    if (GLOBAL_ROLES.includes(req.user.role) && campusId) campusFilter.schoolCampus = campusId;

    const { data, total } = await partnerService.listApplications({
      campusFilter,
      status: ['pending', 'approved', 'rejected'].includes(status) ? status : undefined,
      page:   safePage,
      limit:  safeLimit,
    });

    return sendPaginated(res, 200, 'Applications retrieved.', data, {
      total, page: safePage, limit: safeLimit,
    });
  } catch (err) {
    console.error('list applications error:', err);
    return sendError(res, 500, 'Failed to fetch applications.');
  }
};

// ─── GET ONE ──────────────────────────────────────────────────────────────────
const getOne = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid application ID format.');
    const doc = await partnerService.getApplicationById(req.params.id, buildCampusFilter(req.user));
    if (!doc) return sendNotFound(res, 'Application');
    return sendSuccess(res, 200, 'Application retrieved.', doc);
  } catch (err) {
    console.error('getOne application error:', err);
    return sendError(res, 500, 'Failed to fetch application.');
  }
};

// ─── REVIEW (approve / reject) ────────────────────────────────────────────────
const review = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid application ID format.');

    const { status, reviewNote, partnerId } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return sendError(res, 400, "status must be 'approved' or 'rejected'.");
    }

    const { result, application } = await partnerService.reviewApplication({
      id:           req.params.id,
      campusFilter: buildCampusFilter(req.user),
      status,
      reviewNote:   reviewNote?.trim() || null,
      partnerId:    partnerId && isValidObjectId(partnerId) ? partnerId : null,
      reviewerId:   req.user._id,
    });

    if (result === 'NOT_FOUND') return sendNotFound(res, 'Application');
    if (result === 'CONFLICT')  return sendError(res, 409, 'Application has already been reviewed.');
    return sendSuccess(res, 200, `Application ${status}.`, application);
  } catch (err) {
    console.error('review application error:', err);
    return sendError(res, 500, 'Failed to review application.');
  }
};

// ─── DELETE ───────────────────────────────────────────────────────────────────
const remove = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid application ID format.');
    const deleted = await partnerService.deleteApplication(req.params.id, buildCampusFilter(req.user));
    if (!deleted) return sendNotFound(res, 'Application');
    return sendSuccess(res, 200, 'Application deleted.');
  } catch (err) {
    console.error('delete application error:', err);
    return sendError(res, 500, 'Failed to delete application.');
  }
};

module.exports = { list, getOne, review, remove };
