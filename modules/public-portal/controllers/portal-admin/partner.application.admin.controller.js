'use strict';

/**
 * @file partner.application.admin.controller.js
 * @description Authenticated review of PartnerApplication records (spec §4.9).
 *
 * Admins list, review, approve, or reject partner applications.
 * Approval does NOT auto-create a Partner record — the admin does that manually
 * after reviewing; this controller just sets status + partnerId reference.
 */

const PartnerApplication = require('../../../../models/partner-models/partner.application.model');
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
    const skip = (safePage - 1) * safeLimit;

    const filter = { honeypotTripped: false, ...buildCampusFilter(req.user) };
    if (GLOBAL_ROLES.includes(req.user.role) && campusId) filter.schoolCampus = campusId;
    if (['pending', 'approved', 'rejected'].includes(status)) filter.status = status;

    const [data, total] = await Promise.all([
      PartnerApplication.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
      PartnerApplication.countDocuments(filter),
    ]);

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
    const doc = await PartnerApplication.findOne({
      _id: req.params.id,
      ...buildCampusFilter(req.user),
    }).lean();
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

    const doc = await PartnerApplication.findOne({
      _id:              req.params.id,
      ...buildCampusFilter(req.user),
    });
    if (!doc) return sendNotFound(res, 'Application');
    if (doc.status !== 'pending') {
      return sendError(res, 409, 'Application has already been reviewed.');
    }

    doc.status     = status;
    doc.reviewedBy = req.user._id;
    doc.reviewedAt = new Date();
    if (reviewNote?.trim()) doc.reviewNote = reviewNote.trim();
    if (status === 'approved' && partnerId && isValidObjectId(partnerId)) {
      doc.partnerId = partnerId;
    }

    await doc.save();
    return sendSuccess(res, 200, `Application ${status}.`, doc);
  } catch (err) {
    console.error('review application error:', err);
    return sendError(res, 500, 'Failed to review application.');
  }
};

// ─── DELETE ───────────────────────────────────────────────────────────────────
const remove = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid application ID format.');
    const doc = await PartnerApplication.findOneAndDelete({
      _id: req.params.id,
      ...buildCampusFilter(req.user),
    });
    if (!doc) return sendNotFound(res, 'Application');
    return sendSuccess(res, 200, 'Application deleted.');
  } catch (err) {
    console.error('delete application error:', err);
    return sendError(res, 500, 'Failed to delete application.');
  }
};

module.exports = { list, getOne, review, remove };
