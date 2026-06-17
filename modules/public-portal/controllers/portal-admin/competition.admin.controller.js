'use strict';

/**
 * @file competition.admin.controller.js
 * @description Authenticated CRUD for the monthly competition (CompetitionPrize).
 *
 * Differs from the generic content factory: the resource carries a prize schedule,
 * a closing date and a cron-populated winners[] list (read-only here). Admins can
 * also flip isActive or trigger an immediate closing (reusing the cron's
 * closeCompetition), which freezes winners from the period's QuizSessions.
 */

const repo = require('../../public-portal.repository');
const { closeCompetition } = require('../../competition.closing.cron');
const {
  buildCampusFilter,
  resolveCampusId,
  GLOBAL_ROLES,
} = require('./portal-admin.factory');
const {
  sendSuccess,
  sendCreated,
  sendError,
  sendPaginated,
  sendNotFound,
} = require('../../../../shared/utils/response-helpers');
const { isValidObjectId } = require('../../../../shared/utils/validation-helpers');

// Editable fields — winners[] is managed by the cron, never set from the request.
const EDITABLE = ['period', 'prizes', 'closingDate', 'isActive'];

// ─── CREATE ────────────────────────────────────────────────────────────────────
const create = async (req, res) => {
  try {
    const campusId = resolveCampusId(req.user, req.body);
    if (!campusId) return sendError(res, 400, 'campusId is required.');
    if (!isValidObjectId(campusId)) return sendError(res, 400, 'Invalid campusId format.');

    const doc = { schoolCampus: campusId };
    for (const key of EDITABLE) {
      if (req.body[key] !== undefined) doc[key] = req.body[key];
    }

    const created = await repo.createCompetition(doc);
    return sendCreated(res, 'Competition created.', created);
  } catch (err) {
    if (err.name === 'ValidationError') {
      const msg = Object.values(err.errors)[0]?.message || 'Validation failed.';
      return sendError(res, 400, msg);
    }
    if (err.code === 11000) {
      return sendError(res, 409, 'A competition already exists for this campus and period.');
    }
    console.error('create competition error:', err);
    return sendError(res, 500, 'Failed to create competition.');
  }
};

// ─── LIST ──────────────────────────────────────────────────────────────────────
const list = async (req, res) => {
  try {
    const { page = 1, limit = 20, active, campusId } = req.query;
    const safePage  = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const skip = (safePage - 1) * safeLimit;

    const filter = { ...buildCampusFilter(req.user) };
    if (GLOBAL_ROLES.includes(req.user.role) && campusId) filter.schoolCampus = campusId;
    if (active === 'true')  filter.isActive = true;
    if (active === 'false') filter.isActive = false;

    const { data, total } = await repo.paginateCompetitions(filter, { skip, limit: safeLimit });

    return sendPaginated(res, 200, 'Competitions retrieved.', data, {
      total, page: safePage, limit: safeLimit,
    });
  } catch (err) {
    console.error('list competition error:', err);
    return sendError(res, 500, 'Failed to fetch competitions.');
  }
};

// ─── GET ONE ───────────────────────────────────────────────────────────────────
const getOne = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid competition ID format.');
    const doc = await repo.findCompetitionLean({ _id: req.params.id, ...buildCampusFilter(req.user) });
    if (!doc) return sendNotFound(res, 'Competition');
    return sendSuccess(res, 200, 'Competition retrieved.', doc);
  } catch (err) {
    console.error('getOne competition error:', err);
    return sendError(res, 500, 'Failed to fetch competition.');
  }
};

// ─── UPDATE ────────────────────────────────────────────────────────────────────
const update = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid competition ID format.');
    const doc = await repo.findCompetitionForWrite({ _id: req.params.id, ...buildCampusFilter(req.user) });
    if (!doc) return sendNotFound(res, 'Competition');

    for (const key of EDITABLE) {
      if (req.body[key] !== undefined) doc[key] = req.body[key];
    }

    await repo.saveCompetitionDoc(doc);
    return sendSuccess(res, 200, 'Competition updated.', doc);
  } catch (err) {
    if (err.name === 'ValidationError') {
      const msg = Object.values(err.errors)[0]?.message || 'Validation failed.';
      return sendError(res, 400, msg);
    }
    console.error('update competition error:', err);
    return sendError(res, 500, 'Failed to update competition.');
  }
};

// ─── TOGGLE ACTIVE ───────────────────────────────────────────────────────────────
const toggleActive = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid competition ID format.');
    const doc = await repo.findCompetitionForWrite({ _id: req.params.id, ...buildCampusFilter(req.user) });
    if (!doc) return sendNotFound(res, 'Competition');

    doc.isActive = typeof req.body.isActive === 'boolean' ? req.body.isActive : !doc.isActive;
    await repo.saveCompetitionDoc(doc);

    return sendSuccess(res, 200, `Competition ${doc.isActive ? 'activated' : 'deactivated'}.`, doc);
  } catch (err) {
    console.error('toggleActive competition error:', err);
    return sendError(res, 500, 'Failed to update competition status.');
  }
};

// ─── CLOSE NOW ───────────────────────────────────────────────────────────────────
// Freezes winners from the period's QuizSessions and sets isActive:false.
const closeNow = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid competition ID format.');
    // Campus guard: ensure the competition belongs to the caller's scope first.
    const doc = await repo.findCompetitionScopedStatus({ _id: req.params.id, ...buildCampusFilter(req.user) });
    if (!doc) return sendNotFound(res, 'Competition');
    if (!doc.isActive) return sendError(res, 400, 'Competition is already closed.');

    await closeCompetition(doc._id);
    const updated = await repo.findCompetitionByIdLean(doc._id);
    return sendSuccess(res, 200, 'Competition closed and winners frozen.', updated);
  } catch (err) {
    console.error('closeNow competition error:', err);
    return sendError(res, 500, 'Failed to close competition.');
  }
};

// ─── DELETE ──────────────────────────────────────────────────────────────────────
const remove = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid competition ID format.');
    const doc = await repo.deleteCompetition({ _id: req.params.id, ...buildCampusFilter(req.user) });
    if (!doc) return sendNotFound(res, 'Competition');
    return sendSuccess(res, 200, 'Competition deleted.');
  } catch (err) {
    console.error('delete competition error:', err);
    return sendError(res, 500, 'Failed to delete competition.');
  }
};

module.exports = { create, list, getOne, update, toggleActive, closeNow, remove };
