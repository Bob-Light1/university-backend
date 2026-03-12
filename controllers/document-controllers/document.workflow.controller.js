'use strict';

/**
 * @file document.workflow.controller.js
 * @description Document lifecycle workflow operations.
 *
 * Routes handled:
 *   POST /api/documents/:id/publish        — DRAFT → PUBLISHED
 *   POST /api/documents/:id/archive        — PUBLISHED → ARCHIVED
 *   POST /api/documents/:id/restore        — ARCHIVED → DRAFT (requires reason)
 *   POST /api/documents/:id/duplicate      — Creates a new DRAFT copy
 *   POST /api/documents/:id/lock           — PUBLISHED → LOCKED (ADMIN/DIRECTOR only)
 *   POST /api/documents/:id/unlock         — LOCKED → PUBLISHED (ADMIN/DIRECTOR only)
 *   POST /api/documents/:id/mark-official  — Sets isOfficial=true
 *
 * Version snapshots:
 *   - Pre-publish: snapshot taken before status transition
 *   - Pre-archive: snapshot taken before archiving
 *
 * Audit entries are written for every workflow transition.
 */

const mongoose = require('mongoose');

const Document        = require('../../models/document-models/document.model');
const { DOCUMENT_STATUS } = require('../../models/document-models/document.model');
const { AUDIT_ACTION }    = require('../../models/document-models/documentAudit.model');
const documentService     = require('../../services/document-services/document.service');
const { nanoid }          = require('nanoid');
const slugify             = require('slugify');

const {
  sendSuccess, sendError, sendForbidden, sendNotFound, asyncHandler,
} = require('../../utils/responseHelpers');

// ── Publish ───────────────────────────────────────────────────────────────────

/**
 * POST /api/documents/:id/publish
 * Transitions a document from DRAFT to PUBLISHED.
 * Takes a pre-publish version snapshot.
 * Only CAMPUS_MANAGER and above can publish.
 */
const publishDocument = asyncHandler(async (req, res) => {
  if (!['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role)) {
    return sendForbidden(res, 'Publishing requires CAMPUS_MANAGER or higher role');
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const doc = await Document
      .findOne({ _id: req.params.id, campusId: req.isGlobalRole ? undefined : req.campusId, deletedAt: null })
      .session(session);

    if (!doc) { await session.abortTransaction(); return sendNotFound(res, 'Document'); }
    if (doc.status !== DOCUMENT_STATUS.DRAFT) {
      await session.abortTransaction();
      return sendError(res, 409, `Cannot publish a document with status: ${doc.status}`);
    }

    // Snapshot before status change
    await documentService.takeVersionSnapshot(doc, 'pre-publish', req, session);

    doc.status      = DOCUMENT_STATUS.PUBLISHED;
    doc.publishedAt = new Date();
    doc.lastModifiedBy = { userId: req.user.id, userModel: documentService.resolveUserModel(req.user.role) };
    await doc.save({ session });

    await documentService.writeAudit(session, {
      documentId: doc._id,
      campusId:   doc.campusId,
      action:     AUDIT_ACTION.PUBLISH,
      req,
    });

    await session.commitTransaction();
    return sendSuccess(res, 200, 'Document published successfully', { document: doc });

  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
});

// ── Archive ───────────────────────────────────────────────────────────────────

/**
 * POST /api/documents/:id/archive
 * Transitions a PUBLISHED document to ARCHIVED.
 * Takes a pre-archive version snapshot.
 * reason is optional.
 */
const archiveDocument = asyncHandler(async (req, res) => {
  if (!['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role)) {
    return sendForbidden(res, 'Archiving requires CAMPUS_MANAGER or higher role');
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const doc = await Document
      .findOne({ _id: req.params.id, campusId: req.isGlobalRole ? undefined : req.campusId, deletedAt: null })
      .session(session);

    if (!doc) { await session.abortTransaction(); return sendNotFound(res, 'Document'); }
    if (![DOCUMENT_STATUS.PUBLISHED, DOCUMENT_STATUS.LOCKED].includes(doc.status)) {
      await session.abortTransaction();
      return sendError(res, 409, `Cannot archive a document with status: ${doc.status}`);
    }

    await documentService.takeVersionSnapshot(doc, 'pre-archive', req, session);

    doc.status     = DOCUMENT_STATUS.ARCHIVED;
    doc.archivedAt = new Date();
    doc.lastModifiedBy = { userId: req.user.id, userModel: documentService.resolveUserModel(req.user.role) };
    await doc.save({ session });

    await documentService.writeAudit(session, {
      documentId: doc._id,
      campusId:   doc.campusId,
      action:     AUDIT_ACTION.ARCHIVE,
      req,
      reason:     req.body.reason || null,
    });

    await session.commitTransaction();
    return sendSuccess(res, 200, 'Document archived successfully', { document: doc });

  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
});

// ── Restore ───────────────────────────────────────────────────────────────────

/**
 * POST /api/documents/:id/restore
 * Transitions an ARCHIVED document back to DRAFT.
 * Requires a reason (min 10 characters).
 */
const restoreDocument = asyncHandler(async (req, res) => {
  if (!['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role)) {
    return sendForbidden(res, 'Restoring requires CAMPUS_MANAGER or higher role');
  }

  const { reason } = req.body;
  if (!reason || reason.trim().length < 10) {
    return sendError(res, 400, 'A reason of at least 10 characters is required to restore a document');
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const doc = await Document
      .findOne({ _id: req.params.id, campusId: req.isGlobalRole ? undefined : req.campusId, deletedAt: null })
      .session(session);

    if (!doc) { await session.abortTransaction(); return sendNotFound(res, 'Document'); }
    if (doc.status !== DOCUMENT_STATUS.ARCHIVED) {
      await session.abortTransaction();
      return sendError(res, 409, `Cannot restore a document with status: ${doc.status}`);
    }

    doc.status     = DOCUMENT_STATUS.DRAFT;
    doc.archivedAt = null;
    doc.lastModifiedBy = { userId: req.user.id, userModel: documentService.resolveUserModel(req.user.role) };
    await doc.save({ session });

    await documentService.writeAudit(session, {
      documentId: doc._id,
      campusId:   doc.campusId,
      action:     AUDIT_ACTION.RESTORE,
      req,
      reason,
    });

    await session.commitTransaction();
    return sendSuccess(res, 200, 'Document restored to draft successfully', { document: doc });

  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
});

// ── Duplicate ─────────────────────────────────────────────────────────────────

/**
 * POST /api/documents/:id/duplicate
 * Creates a new DRAFT document as a copy of the source.
 * New ref and slug are generated. Status is reset to DRAFT.
 * Linked entities and template references are preserved.
 */
const duplicateDocument = asyncHandler(async (req, res) => {
  if (!['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role)) {
    return sendForbidden(res, 'Duplicating requires CAMPUS_MANAGER or higher role');
  }

  const source = await Document
    .findOne({ _id: req.params.id, campusId: req.isGlobalRole ? undefined : req.campusId, deletedAt: null })
    .lean();

  if (!source) return sendNotFound(res, 'Document');

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const newTitle    = req.body.title || `${source.title} (Copy)`;
    const baseSlug    = slugify(newTitle, { lower: true, strict: true });
    const newRef      = `DOC-${new Date().getFullYear()}-CPY-${nanoid(8).toUpperCase()}`;

    const copyData = {
      ...source,
      _id:            undefined,
      ref:            newRef,
      slug:           `${baseSlug}-${nanoid(4).toLowerCase()}`,
      title:          newTitle,
      status:         DOCUMENT_STATUS.DRAFT,
      publishedAt:    null,
      archivedAt:     null,
      lockedAt:       null,
      pdfSnapshot:    null,
      downloadCount:  0,
      printCount:     0,
      currentVersion: 1,
      versionHistory: [],
      lastAuditEntry: null,
      deletedAt:      null,
      deletedBy:      { userId: null, userModel: null },
      createdAt:      undefined,
      updatedAt:      undefined,
      createdBy: {
        userId:    req.user.id,
        userModel: documentService.resolveUserModel(req.user.role),
      },
      lastModifiedBy: { userId: null, userModel: null },
    };

    const [duplicate] = await Document.create([copyData], { session });

    await documentService.writeAudit(session, {
      documentId: duplicate._id,
      campusId:   duplicate.campusId,
      action:     AUDIT_ACTION.DUPLICATE,
      req,
      metadata:   { sourceDocumentId: source._id, sourceRef: source.ref },
    });

    await session.commitTransaction();
    return sendSuccess(res, 201, 'Document duplicated successfully', { document: duplicate });

  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
});

// ── Lock ──────────────────────────────────────────────────────────────────────

/**
 * POST /api/documents/:id/lock
 * Locks a PUBLISHED document. ADMIN/DIRECTOR only.
 * Requires a reason (min 10 characters).
 */
const lockDocument = asyncHandler(async (req, res) => {
  if (!['ADMIN', 'DIRECTOR'].includes(req.user.role)) {
    return sendForbidden(res, 'Locking a document requires ADMIN or DIRECTOR role');
  }

  const { reason } = req.body;
  if (!reason || reason.trim().length < 10) {
    return sendError(res, 400, 'A reason of at least 10 characters is required to lock a document');
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const doc = await Document.findById(req.params.id).session(session);
    if (!doc || doc.deletedAt) { await session.abortTransaction(); return sendNotFound(res, 'Document'); }

    if (doc.status === DOCUMENT_STATUS.LOCKED) {
      await session.abortTransaction();
      return sendError(res, 409, 'Document is already locked');
    }
    if (doc.status !== DOCUMENT_STATUS.PUBLISHED) {
      await session.abortTransaction();
      return sendError(res, 409, 'Only PUBLISHED documents can be locked');
    }

    doc.status   = DOCUMENT_STATUS.LOCKED;
    doc.lockedAt = new Date();
    await doc.save({ session });

    await documentService.writeAudit(session, {
      documentId: doc._id, campusId: doc.campusId,
      action: AUDIT_ACTION.LOCK, req, reason,
    });

    await session.commitTransaction();
    return sendSuccess(res, 200, 'Document locked successfully', { document: doc });

  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
});

// ── Unlock ────────────────────────────────────────────────────────────────────

/**
 * POST /api/documents/:id/unlock
 * Unlocks a LOCKED document back to PUBLISHED. ADMIN/DIRECTOR only.
 * Requires a reason (min 10 characters).
 */
const unlockDocument = asyncHandler(async (req, res) => {
  if (!['ADMIN', 'DIRECTOR'].includes(req.user.role)) {
    return sendForbidden(res, 'Unlocking a document requires ADMIN or DIRECTOR role');
  }

  const { reason } = req.body;
  if (!reason || reason.trim().length < 10) {
    return sendError(res, 400, 'A reason of at least 10 characters is required to unlock a document');
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const doc = await Document.findById(req.params.id).session(session);
    if (!doc || doc.deletedAt) { await session.abortTransaction(); return sendNotFound(res, 'Document'); }

    if (doc.status !== DOCUMENT_STATUS.LOCKED) {
      await session.abortTransaction();
      return sendError(res, 409, 'Document is not locked');
    }

    doc.status   = DOCUMENT_STATUS.PUBLISHED;
    doc.lockedAt = null;
    await doc.save({ session });

    await documentService.writeAudit(session, {
      documentId: doc._id, campusId: doc.campusId,
      action: AUDIT_ACTION.UNLOCK, req, reason,
    });

    await session.commitTransaction();
    return sendSuccess(res, 200, 'Document unlocked successfully', { document: doc });

  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
});

// ── Mark Official ─────────────────────────────────────────────────────────────

/**
 * POST /api/documents/:id/mark-official
 * Sets isOfficial=true on a document.
 * Official documents auto-lock on their first external share access.
 * Only CAMPUS_MANAGER and above can mark documents as official.
 */
const markOfficial = asyncHandler(async (req, res) => {
  if (!['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role)) {
    return sendForbidden(res, 'Marking a document as official requires CAMPUS_MANAGER or higher role');
  }

  const doc = await Document.findByIdAndUpdate(
    req.params.id,
    { isOfficial: true, lastModifiedBy: { userId: req.user.id, userModel: documentService.resolveUserModel(req.user.role) } },
    { new: true },
  );

  if (!doc) return sendNotFound(res, 'Document');

  await documentService.writeAudit(null, {
    documentId: doc._id,
    campusId:   doc.campusId,
    action:     AUDIT_ACTION.UPDATE,
    req,
    fieldChanged: 'isOfficial',
    oldValue:     false,
    newValue:     true,
    reason:       'Marked as official document',
  });

  return sendSuccess(res, 200, 'Document marked as official', { document: doc });
});

module.exports = {
  publishDocument,
  archiveDocument,
  restoreDocument,
  duplicateDocument,
  lockDocument,
  unlockDocument,
  markOfficial,
};