'use strict';

/**
 * @file portal-admin.factory.js
 * @description Generic authenticated CRUD controller factory for the Phase 2 portal
 * content resources (Testimonial, FaqEntry, CoursePreview).
 *
 * These resources share the same shape: campus-isolated, `isPublished` flag, `order`
 * field, bilingual content. The factory produces create/list/getOne/update/
 * togglePublish/remove handlers so each resource stays a one-liner wiring step.
 *
 * Campus scoping mirrors announcement.admin.controller.js:
 *   ADMIN / DIRECTOR  → all campuses (may narrow via campusId)
 *   other mgmt roles  → forced to their own campusId
 */

const {
  sendSuccess,
  sendCreated,
  sendError,
  sendPaginated,
  sendNotFound,
} = require('../../../../shared/utils/response-helpers');
const { isValidObjectId } = require('../../../../shared/utils/validation-helpers');

const GLOBAL_ROLES = ['ADMIN', 'DIRECTOR'];

const escapeRegex = (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Fire-and-forget AI ingestion signal for an ingestable content resource
 * (§6.3). Only the PUBLIC corpus (programmes/FAQ) passes an `ingestSourceType`;
 * Testimonials never signal. Never awaited — the ai-service re-reads the source
 * and indexes it (published) or prunes it (unpublished/deleted) idempotently,
 * so a create/update/publish/delete can all reuse the same nudge. Lazy require
 * keeps the ai module out of the load-order path.
 */
const signalIngest = (ingestSourceType, doc) => {
  if (!ingestSourceType || !doc?.schoolCampus || !doc?._id) return;
  require('../../../ai').service.signalIngest({
    campusId: doc.schoolCampus,
    sourceId: doc._id,
    sourceType: ingestSourceType,
  });
};

const buildCampusFilter = (user) =>
  GLOBAL_ROLES.includes(user.role) ? {} : { schoolCampus: user.campusId };

const resolveCampusId = (user, body) =>
  GLOBAL_ROLES.includes(user.role) ? body.campusId : user.campusId;

/**
 * @param {object} repo            Content-repo slice liée au model (public-portal.repository → contentRepo(name)).
 * @param {object} opts
 * @param {string}   opts.label        Human label for messages (e.g. 'Testimonial').
 * @param {string[]} opts.allowed      Body fields accepted on create/update.
 * @param {string[]} [opts.searchKeys] Document paths searched by ?search= (regex).
 * @param {string}   [opts.ingestSourceType] AI source type for the vectorial
 *   index (§6.3) — set only for the PUBLIC corpus (programmes/FAQ). Mutations
 *   then emit a fire-and-forget ingestion signal.
 */
function makeContentController(repo, { label, allowed, searchKeys = [], ingestSourceType = null }) {
  // ─── CREATE ────────────────────────────────────────────────────────────────
  const create = async (req, res) => {
    try {
      const campusId = resolveCampusId(req.user, req.body);
      if (!campusId) return sendError(res, 400, 'campusId is required.');
      if (!isValidObjectId(campusId)) return sendError(res, 400, 'Invalid campusId format.');

      const doc = { schoolCampus: campusId };
      for (const key of allowed) {
        if (req.body[key] !== undefined) doc[key] = req.body[key];
      }

      const created = await repo.create(doc);
      signalIngest(ingestSourceType, created);
      return sendCreated(res, `${label} created.`, created);
    } catch (err) {
      if (err.name === 'ValidationError') {
        const msg = Object.values(err.errors)[0]?.message || 'Validation failed.';
        return sendError(res, 400, msg);
      }
      console.error(`create ${label} error:`, err);
      return sendError(res, 500, `Failed to create ${label.toLowerCase()}.`);
    }
  };

  // ─── LIST ──────────────────────────────────────────────────────────────────
  const list = async (req, res) => {
    try {
      const { page = 1, limit = 20, search, published, campusId } = req.query;
      const safePage  = Math.max(1, Number(page) || 1);
      const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
      const skip = (safePage - 1) * safeLimit;

      const filter = { ...buildCampusFilter(req.user) };
      if (GLOBAL_ROLES.includes(req.user.role) && campusId) filter.schoolCampus = campusId;
      if (published === 'true')  filter.isPublished = true;
      if (published === 'false') filter.isPublished = false;

      if (search && searchKeys.length) {
        const rx = new RegExp(escapeRegex(search), 'i');
        filter.$or = searchKeys.map((k) => ({ [k]: rx }));
      }

      const { data, total } = await repo.paginate(filter, { skip, limit: safeLimit });

      return sendPaginated(res, 200, `${label}s retrieved.`, data, {
        total, page: safePage, limit: safeLimit,
      });
    } catch (err) {
      console.error(`list ${label} error:`, err);
      return sendError(res, 500, `Failed to fetch ${label.toLowerCase()}s.`);
    }
  };

  // ─── GET ONE ───────────────────────────────────────────────────────────────
  const getOne = async (req, res) => {
    try {
      if (!isValidObjectId(req.params.id)) return sendError(res, 400, `Invalid ${label} ID format.`);
      const doc = await repo.findOneLean({ _id: req.params.id, ...buildCampusFilter(req.user) });
      if (!doc) return sendNotFound(res, label);
      return sendSuccess(res, 200, `${label} retrieved.`, doc);
    } catch (err) {
      console.error(`getOne ${label} error:`, err);
      return sendError(res, 500, `Failed to fetch ${label.toLowerCase()}.`);
    }
  };

  // ─── UPDATE ────────────────────────────────────────────────────────────────
  const update = async (req, res) => {
    try {
      if (!isValidObjectId(req.params.id)) return sendError(res, 400, `Invalid ${label} ID format.`);
      const doc = await repo.findOneForWrite({ _id: req.params.id, ...buildCampusFilter(req.user) });
      if (!doc) return sendNotFound(res, label);

      for (const key of allowed) {
        if (req.body[key] !== undefined) doc[key] = req.body[key];
      }

      await repo.save(doc);
      signalIngest(ingestSourceType, doc);
      return sendSuccess(res, 200, `${label} updated.`, doc);
    } catch (err) {
      if (err.name === 'ValidationError') {
        const msg = Object.values(err.errors)[0]?.message || 'Validation failed.';
        return sendError(res, 400, msg);
      }
      console.error(`update ${label} error:`, err);
      return sendError(res, 500, `Failed to update ${label.toLowerCase()}.`);
    }
  };

  // ─── TOGGLE PUBLISH ──────────────────────────────────────────────────────────
  const togglePublish = async (req, res) => {
    try {
      if (!isValidObjectId(req.params.id)) return sendError(res, 400, `Invalid ${label} ID format.`);
      const doc = await repo.findOneForWrite({ _id: req.params.id, ...buildCampusFilter(req.user) });
      if (!doc) return sendNotFound(res, label);

      doc.isPublished = typeof req.body.isPublished === 'boolean' ? req.body.isPublished : !doc.isPublished;
      await repo.save(doc);
      // Publish → index, unpublish → prune (ai-service re-reads and decides).
      signalIngest(ingestSourceType, doc);

      return sendSuccess(res, 200, `${label} ${doc.isPublished ? 'published' : 'unpublished'}.`, doc);
    } catch (err) {
      console.error(`togglePublish ${label} error:`, err);
      return sendError(res, 500, `Failed to update ${label.toLowerCase()} status.`);
    }
  };

  // ─── DELETE ──────────────────────────────────────────────────────────────────
  const remove = async (req, res) => {
    try {
      if (!isValidObjectId(req.params.id)) return sendError(res, 400, `Invalid ${label} ID format.`);
      const doc = await repo.findOneAndDelete({ _id: req.params.id, ...buildCampusFilter(req.user) });
      if (!doc) return sendNotFound(res, label);
      // Deleted source is no longer ingestable → the signal triggers a prune.
      signalIngest(ingestSourceType, doc);
      return sendSuccess(res, 200, `${label} deleted.`);
    } catch (err) {
      console.error(`delete ${label} error:`, err);
      return sendError(res, 500, `Failed to delete ${label.toLowerCase()}.`);
    }
  };

  return { create, list, getOne, update, togglePublish, remove };
}

module.exports = { makeContentController, buildCampusFilter, resolveCampusId, GLOBAL_ROLES };
