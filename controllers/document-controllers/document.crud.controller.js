'use strict';

/**
 * @file document.crud.controller.js
 * @description CRUD operations for documents.
 *
 * Routes handled:
 *   POST   /api/documents                 — Create (rich content or file import)
 *   GET    /api/documents                 — List with filters and pagination
 *   GET    /api/documents/:id             — Get single document
 *   PATCH  /api/documents/:id             — Partial update
 *   DELETE /api/documents/:id             — Soft delete or hard delete (ADMIN/DIRECTOR)
 *
 * Campus isolation: enforced via buildCampusFilter (Layer 2) in every DB operation.
 * All controllers are wrapped with asyncHandler from responseHelpers.js.
 */

const {
  sendSuccess, sendCreated, sendError, sendNotFound,
  sendForbidden, sendPaginated, asyncHandler,
} = require('../../utils/responseHelpers');

const documentService = require('../../services/document-services/document.service');
const storageService  = require('../../services/document-services/document.storage.service');
const { invalidateStorageCache } = require('../../middleware/document-middleware/document.campus.middleware');

// ── Create Document ───────────────────────────────────────────────────────────

/**
 * POST /api/documents
 * Creates a rich-content document or registers an imported file.
 * For IMPORTED type, processes the uploaded file via multer (req.file).
 */
const createDocument = asyncHandler(async (req, res) => {
  const dto = { ...req.body };

  // Resolve effective campusId:
  //   - Regular roles: req.campusId is set by enforceCampusAccess from the JWT.
  //   - ADMIN / DIRECTOR (global roles): req.campusId is null because they have
  //     cross-campus access. They must supply campusId in the request body so the
  //     document can be routed to the correct campus storage directory and DB record.
  const effectiveCampusId = req.campusId ?? dto.campusId ?? null;

  if (!effectiveCampusId) {
    return sendError(
      res,
      400,
      'campusId is required. Global roles (ADMIN, DIRECTOR) must supply campusId in the request body.',
    );
  }

  // Handle file import (IMPORTED document type)
  if (req.file) {
    const saved = await storageService.saveFile(req.file, effectiveCampusId, 'imported');
    dto.type         = 'IMPORTED';
    dto.importedFile = {
      fileName:     saved.fileName,
      originalName: saved.originalName,
      mimeType:     saved.mimeType,
      sizeBytes:    saved.sizeBytes,
      extension:    saved.extension,
      uploadedAt:   new Date(),
    };
    // Invalidate storage cache for the target campus after successful import
    invalidateStorageCache(effectiveCampusId.toString());
  }

  // Ensure campusId is always propagated to the service layer
  dto.campusId = effectiveCampusId;

  const document = await documentService.createDocument(req, dto);

  return sendCreated(res, 'Document created successfully', { document });
});

// ── List Documents ────────────────────────────────────────────────────────────

/**
 * GET /api/documents
 * Returns a paginated list filtered by type, category, status, tags, date range,
 * and structured metadata fields (studentId, teacherId, courseId, semester, academicYear).
 */
const listDocuments = asyncHandler(async (req, res) => {
  const { data, total, page, limit } = await documentService.listDocuments(req, req.query);

  return sendPaginated(res, 200, 'Documents retrieved successfully', data, {
    total,
    page,
    limit,
  });
});

// ── Get Document ──────────────────────────────────────────────────────────────

/**
 * GET /api/documents/:id
 * Returns a single document with full body and populated linkedEntities.
 * Role-based scope (TEACHER, STUDENT, PARENT) is enforced upstream in middleware.
 */
const getDocument = asyncHandler(async (req, res) => {
  const document = await documentService.getDocumentById(req.params.id, req);

  if (!document) return sendNotFound(res, 'Document');

  return sendSuccess(res, 200, 'Document retrieved successfully', { document });
});

// ── Update Document ───────────────────────────────────────────────────────────

/**
 * PATCH /api/documents/:id
 * Partially updates a document. A reason is required for PUBLISHED and LOCKED documents.
 * Automatically takes a version snapshot before any update to a PUBLISHED document.
 */
const updateDocument = asyncHandler(async (req, res) => {
  const { reason, ...dto } = req.body;

  const document = await documentService.updateDocument(
    req.params.id,
    dto,
    reason,
    req,
  );

  return sendSuccess(res, 200, 'Document updated successfully', { document });
});

// ── Delete Document ───────────────────────────────────────────────────────────

/**
 * DELETE /api/documents/:id
 * Soft delete: available to all authorized roles (with reason).
 * Hard delete: ADMIN/DIRECTOR only, triggered by query param ?hard=true.
 *
 * CAMPUS_MANAGER can only soft-delete DRAFT documents.
 * LOCKED documents cannot be deleted without prior unlock.
 * Audit records are NEVER deleted by either operation.
 */
const deleteDocument = asyncHandler(async (req, res) => {
  const isHardDelete = req.query.hard === 'true';
  const { reason }   = req.body;

  if (isHardDelete) {
    if (!['ADMIN', 'DIRECTOR'].includes(req.user.role)) {
      return sendForbidden(res, 'Hard delete requires ADMIN or DIRECTOR role');
    }
    await documentService.hardDeleteDocument(req.params.id, req);
    return sendSuccess(res, 200, 'Document permanently deleted');
  }

  await documentService.softDeleteDocument(req.params.id, reason, req);
  return sendSuccess(res, 200, 'Document deleted successfully');
});

module.exports = {
  createDocument,
  listDocuments,
  getDocument,
  updateDocument,
  deleteDocument,
};