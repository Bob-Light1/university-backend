'use strict';

/**
 * @file document.audit.controller.js
 * @description Audit log and version history endpoints.
 *
 * Routes handled:
 *   GET  /api/documents/:id/audit               — Paginated audit log for one document
 *   GET  /api/documents/audit/campus            — Paginated audit log for all campus documents
 *   GET  /api/documents/:id/versions            — List all versions (paginated)
 *   GET  /api/documents/:id/versions/:version   — Get a specific version snapshot
 *   POST /api/documents/:id/versions/:version/restore — Restore to a version (requires reason)
 */

const DocumentAudit   = require('../../models/document-models/documentAudit.model');
const DocumentVersion = require('../../models/document-models/documentVersion.model');
const Document        = require('../../models/document-models/document.model');
const { AUDIT_ACTION }    = require('../../models/document-models/documentAudit.model');
const documentService     = require('../../services/document-services/document.service');

const {
  sendSuccess, sendError, sendForbidden, sendNotFound, sendPaginated, asyncHandler,
} = require('../../utils/responseHelpers');

// ── Audit: Single Document ────────────────────────────────────────────────────

/**
 * GET /api/documents/:id/audit?page=1&limit=20
 * Returns paginated audit history for a specific document.
 * Available to CAMPUS_MANAGER and above only.
 */
const getDocumentAudit = asyncHandler(async (req, res) => {
  if (!['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role)) {
    return sendForbidden(res, 'Audit log access requires CAMPUS_MANAGER or higher role');
  }

  const { page = 1, limit = 20 } = req.query;
  const pageNum  = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const skip     = (pageNum - 1) * limitNum;

  const filter = { documentId: req.params.id };
  if (!req.isGlobalRole) filter.campusId = req.campusId;

  const [data, total] = await Promise.all([
    DocumentAudit
      .find(filter)
      .sort({ performedAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    DocumentAudit.countDocuments(filter),
  ]);

  return sendPaginated(res, 200, 'Audit log retrieved', data, { total, page: pageNum, limit: limitNum });
});

// ── Audit: Campus-wide ────────────────────────────────────────────────────────

/**
 * GET /api/documents/audit/campus?page=1&limit=20&action=PUBLISH&from=&to=
 * Returns a paginated, filterable audit feed for all documents in the campus.
 * Available to CAMPUS_MANAGER and above only.
 */
const getCampusAudit = asyncHandler(async (req, res) => {
  if (!['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role)) {
    return sendForbidden(res, 'Campus audit log requires CAMPUS_MANAGER or higher role');
  }

  const { page = 1, limit = 20, action, from, to } = req.query;
  const pageNum  = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const skip     = (pageNum - 1) * limitNum;

  const filter = {};
  if (!req.isGlobalRole) filter.campusId = req.campusId;
  if (action) filter.action = action;

  if (from || to) {
    filter.performedAt = {};
    if (from) filter.performedAt.$gte = new Date(from);
    if (to)   filter.performedAt.$lte = new Date(to);
  }

  const [data, total] = await Promise.all([
    DocumentAudit
      .find(filter)
      .sort({ performedAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    DocumentAudit.countDocuments(filter),
  ]);

  return sendPaginated(res, 200, 'Campus audit log retrieved', data, { total, page: pageNum, limit: limitNum });
});

// ── Versions: List ────────────────────────────────────────────────────────────

/**
 * GET /api/documents/:id/versions?page=1&limit=20
 * Returns all version snapshots for a document (most recent first).
 * Available to CAMPUS_MANAGER and above.
 */
const listVersions = asyncHandler(async (req, res) => {
  if (!['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role)) {
    return sendForbidden(res, 'Viewing version history requires CAMPUS_MANAGER or higher role');
  }

  const { page = 1, limit = 20 } = req.query;
  const pageNum  = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10)));
  const skip     = (pageNum - 1) * limitNum;

  const filter = { documentId: req.params.id };
  if (!req.isGlobalRole) filter.campusId = req.campusId;

  const [data, total] = await Promise.all([
    DocumentVersion
      .find(filter)
      .sort({ version: -1 })
      .skip(skip)
      .limit(limitNum)
      .select('-body')   // Omit full body from list — use getVersion for full snapshot
      .lean(),
    DocumentVersion.countDocuments(filter),
  ]);

  return sendPaginated(res, 200, 'Version history retrieved', data, { total, page: pageNum, limit: limitNum });
});

// ── Versions: Get One ─────────────────────────────────────────────────────────

/**
 * GET /api/documents/:id/versions/:version
 * Returns the full snapshot of a specific version number.
 */
const getVersion = asyncHandler(async (req, res) => {
  if (!['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role)) {
    return sendForbidden(res, 'Viewing version snapshots requires CAMPUS_MANAGER or higher role');
  }

  const filter = {
    documentId: req.params.id,
    version:    parseInt(req.params.version, 10),
  };
  if (!req.isGlobalRole) filter.campusId = req.campusId;

  const version = await DocumentVersion.findOne(filter).lean();
  if (!version) return sendNotFound(res, 'Version');

  return sendSuccess(res, 200, 'Version snapshot retrieved', { version });
});

// ── Versions: Restore ─────────────────────────────────────────────────────────

/**
 * POST /api/documents/:id/versions/:version/restore
 * Body: { reason }
 * Restores the document body and branding to the specified version snapshot.
 * Takes a snapshot of the current state before restoring.
 * Requires a reason (min 10 characters).
 */
const restoreVersion = asyncHandler(async (req, res) => {
  if (!['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role)) {
    return sendForbidden(res, 'Restoring versions requires CAMPUS_MANAGER or higher role');
  }

  const { reason } = req.body;
  if (!reason || reason.trim().length < 10) {
    return sendError(res, 400, 'A reason of at least 10 characters is required to restore a version');
  }

  const versionFilter = {
    documentId: req.params.id,
    version:    parseInt(req.params.version, 10),
  };
  if (!req.isGlobalRole) versionFilter.campusId = req.campusId;

  const snapshot = await DocumentVersion.findOne(versionFilter).lean();
  if (!snapshot) return sendNotFound(res, 'Version');

  const docFilter = { _id: req.params.id, deletedAt: null };
  if (!req.isGlobalRole) docFilter.campusId = req.campusId;

  const session = await require('mongoose').startSession();
  session.startTransaction();

  try {
    const doc = await Document.findOne(docFilter).session(session);
    if (!doc) { await session.abortTransaction(); return sendNotFound(res, 'Document'); }

    // Take a snapshot of the current state before restoring
    await documentService.takeVersionSnapshot(doc, 'auto', req, session);

    // Restore body and branding from the snapshot
    doc.body     = snapshot.body;
    doc.branding = snapshot.branding || doc.branding;
    doc.lastModifiedBy = {
      userId:    req.user.id,
      userModel: documentService.resolveUserModel(req.user.role),
    };
    await doc.save({ session });

    await documentService.writeAudit(session, {
      documentId: doc._id,
      campusId:   doc.campusId,
      action:     AUDIT_ACTION.VERSION_RESTORE,
      req,
      reason,
      metadata:   { restoredToVersion: snapshot.version },
    });

    await session.commitTransaction();
    return sendSuccess(res, 200, `Document restored to version ${snapshot.version}`, { document: doc });

  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
});

module.exports = {
  getDocumentAudit,
  getCampusAudit,
  listVersions,
  getVersion,
  restoreVersion,
};