'use strict';

/**
 * @file document.export.controller.js
 * @description Document export and print operations.
 *
 * Routes handled:
 *   GET  /api/documents/:id/export/pdf      — Serve cached or freshly generated PDF
 *   GET  /api/documents/:id/export/raw      — Stream original imported file (authenticated)
 *   POST /api/documents/bulk/export         — Package up to 50 documents as a ZIP stream
 *   POST /api/documents/bulk/print          — Enqueue a print job, return jobId
 *   GET  /api/documents/print-jobs/:jobId   — Poll print job status
 *
 * Rate limiting:
 *   PDF export / print endpoints: 5 req/min per user (applied at router level).
 *
 * Audit events:
 *   DOWNLOAD → written on every successful PDF or raw file download.
 *   PRINT    → written when a print job is created.
 */

const mongoose   = require('mongoose');
const archiver   = require('archiver');
const path       = require('path');

const Document       = require('../../models/document-models/document.model');
const { AUDIT_ACTION }   = require('../../models/document-models/documentAudit.model');
const documentService    = require('../../services/document-services/document.service');
const pdfService         = require('../../services/document-services/document.pdf.service');
const storageService     = require('../../services/document-services/document.storage.service');
const Campus             = require('../../models/campus.model');

const {
  sendSuccess, sendError, sendNotFound, sendForbidden, asyncHandler,
} = require('../../utils/responseHelpers');

const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? require('path').join(process.env.UPLOAD_DIR, 'documents')
  : require('path').join(__dirname, '..', '..', 'uploads', 'documents');

// ── In-memory print job registry (Phase 1 — replace with bull in Phase 3) ────

/**
 * @type {Map<string, { status: string, campusId: string, documentIds: string[], downloadUrl?: string, error?: string, createdAt: Date }>}
 */
const printJobs = new Map();

// ── PDF Export ────────────────────────────────────────────────────────────────

/**
 * GET /api/documents/:id/export/pdf
 * Serves the cached PDF snapshot if available and version-matched.
 * Regenerates if the snapshot is missing or stale.
 * Increments downloadCount and writes a DOWNLOAD audit entry.
 */
const exportPdf = asyncHandler(async (req, res) => {
  const doc = await Document
    .findOne({
      _id:       req.params.id,
      campusId:  req.isGlobalRole ? undefined : req.campusId,
      deletedAt: null,
    })
    .select('ref title pdfSnapshot currentVersion campusId status')
    .lean();

  if (!doc) return sendNotFound(res, 'Document');

  const campus     = await Campus.findById(doc.campusId).select('campus_name').lean();
  const campusName = campus?.campus_name || '';

  const { fileName, buffer } = await pdfService.getOrGeneratePdf(doc._id.toString(), campusName);

  // Increment download count (non-blocking)
  Document.findByIdAndUpdate(doc._id, { $inc: { downloadCount: 1 } }).catch(() => {});

  // Write audit (non-blocking)
  documentService.writeAudit(null, {
    documentId: doc._id,
    campusId:   doc.campusId,
    action:     AUDIT_ACTION.DOWNLOAD,
    req,
    metadata:   { format: 'pdf', fileName },
  }).catch(() => {});

  const safeTitle = doc.title.replace(/[^a-zA-Z0-9-_ ]/g, '').slice(0, 50);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.pdf"`);
  res.setHeader('Cache-Control', 'private, no-cache');
  return res.send(buffer);
});

// ── Raw File Stream ───────────────────────────────────────────────────────────

/**
 * GET /api/documents/:id/export/raw
 * Streams the original imported file for IMPORTED document types.
 * Files are never served as static assets — all access is authenticated via this endpoint.
 */
const exportRaw = asyncHandler(async (req, res) => {
  const doc = await Document
    .findOne({
      _id:       req.params.id,
      campusId:  req.isGlobalRole ? undefined : req.campusId,
      deletedAt: null,
    })
    .select('type importedFile campusId title')
    .lean();

  if (!doc) return sendNotFound(res, 'Document');

  if (doc.type !== 'IMPORTED' || !doc.importedFile?.fileName) {
    return sendError(res, 400, 'This document does not have an importable file');
  }

  // Increment download count (non-blocking)
  Document.findByIdAndUpdate(doc._id, { $inc: { downloadCount: 1 } }).catch(() => {});

  documentService.writeAudit(null, {
    documentId: doc._id,
    campusId:   doc.campusId,
    action:     AUDIT_ACTION.DOWNLOAD,
    req,
    metadata:   { format: 'raw', fileName: doc.importedFile.fileName },
  }).catch(() => {});

  const displayName = doc.importedFile.originalName || doc.importedFile.fileName;

  await storageService.streamFile(
    doc.campusId.toString(),
    'imported',
    doc.importedFile.fileName,
    res,
    { download: true, displayName },
  );
});

// ── Bulk Export ───────────────────────────────────────────────────────────────

/**
 * POST /api/documents/bulk/export
 * Body: { documentIds: string[] } — max 50 IDs
 * Streams a ZIP archive containing PDFs for all requested documents.
 * Documents not belonging to the user's campus are silently skipped.
 */
const bulkExport = asyncHandler(async (req, res) => {
  if (!['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role)) {
    return sendForbidden(res, 'Bulk export requires CAMPUS_MANAGER or higher role');
  }

  const { documentIds } = req.body;

  if (!Array.isArray(documentIds) || documentIds.length === 0) {
    return sendError(res, 400, 'documentIds must be a non-empty array');
  }

  const maxBulk = parseInt(process.env.PRINT_JOB_MAX_DOCUMENTS || '50', 10);
  if (documentIds.length > maxBulk) {
    return sendError(res, 400, `Bulk export is limited to ${maxBulk} documents per request`);
  }

  const campusFilter = req.isGlobalRole
    ? { _id: { $in: documentIds }, deletedAt: null }
    : { _id: { $in: documentIds }, campusId: req.campusId, deletedAt: null };

  const documents = await Document
    .find(campusFilter)
    .select('_id ref title campusId pdfSnapshot currentVersion')
    .lean();

  if (documents.length === 0) {
    return sendError(res, 404, 'No accessible documents found for the provided IDs');
  }

  const campus     = req.campusId
    ? await Campus.findById(req.campusId).select('campus_name').lean()
    : null;
  const campusName = campus?.campus_name || '';

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="documents_export_${Date.now()}.zip"`);
  res.setHeader('Cache-Control', 'no-cache');

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (err) => { throw err; });
  archive.pipe(res);

  for (const doc of documents) {
    try {
      const { buffer, fileName } = await pdfService.getOrGeneratePdf(doc._id.toString(), campusName);
      const safeTitle = doc.title.replace(/[^a-zA-Z0-9-_ ]/g, '').slice(0, 50);
      archive.append(buffer, { name: `${safeTitle}_${doc.ref}.pdf` });
    } catch {
      // Skip documents that fail PDF generation — continue with others
    }
  }

  await archive.finalize();
});

// ── Print Queue ───────────────────────────────────────────────────────────────

/**
 * POST /api/documents/bulk/print
 * Body: { documentIds: string[] }
 * Enqueues a print job and returns a jobId for status polling.
 * Processing happens asynchronously via setImmediate (Phase 1).
 * Phase 3: replace with bull queue for persistence and retry.
 */
const enqueuePrintJob = asyncHandler(async (req, res) => {
  if (!['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role)) {
    return sendForbidden(res, 'Print jobs require CAMPUS_MANAGER or higher role');
  }

  const { documentIds } = req.body;

  if (!Array.isArray(documentIds) || documentIds.length === 0) {
    return sendError(res, 400, 'documentIds must be a non-empty array');
  }

  const maxDocs = parseInt(process.env.PRINT_JOB_MAX_DOCUMENTS || '50', 10);
  if (documentIds.length > maxDocs) {
    return sendError(res, 400, `Print job is limited to ${maxDocs} documents`);
  }

  const jobId = `pjob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  printJobs.set(jobId, {
    status:      'QUEUED',
    campusId:    req.campusId?.toString(),
    documentIds,
    createdAt:   new Date(),
    downloadUrl: null,
    error:       null,
  });

  // Write print audit (non-blocking)
  documentService.writeAudit(null, {
    documentId: documentIds[0],
    campusId:   req.campusId,
    action:     AUDIT_ACTION.PRINT,
    req,
    metadata:   { jobId, totalDocuments: documentIds.length },
  }).catch(() => {});

  // Process asynchronously
  setImmediate(() => processPrintJob(jobId, req.campusId?.toString(), documentIds));

  return sendSuccess(res, 202, 'Print job queued', { jobId });
});

/**
 * GET /api/documents/print-jobs/:jobId
 * Returns the current status of a print job.
 * QUEUED → PROCESSING → DONE (with downloadUrl) | FAILED (with error)
 */
const getPrintJobStatus = asyncHandler(async (req, res) => {
  const job = printJobs.get(req.params.jobId);

  if (!job) return sendNotFound(res, 'Print job');

  // Campus scope check — users can only see their own campus jobs
  if (!req.isGlobalRole && job.campusId !== req.campusId?.toString()) {
    return sendForbidden(res, 'Access denied');
  }

  return sendSuccess(res, 200, 'Print job status', { job: { ...job, jobId: req.params.jobId } });
});

/**
 * Processes a print job by generating PDFs for all document IDs and packaging them as a ZIP.
 * Updates job status in the in-memory registry throughout.
 *
 * @param {string}   jobId
 * @param {string}   campusId
 * @param {string[]} documentIds
 */
const processPrintJob = async (jobId, campusId, documentIds) => {
  const job = printJobs.get(jobId);
  if (!job) return;

  job.status = 'PROCESSING';

  try {
    const timeout  = parseInt(process.env.PRINT_JOB_TIMEOUT_MS || '120000', 10);
    const deadline = Date.now() + timeout;

    const campus     = campusId
      ? await Campus.findById(campusId).select('campus_name').lean()
      : null;
    const campusName = campus?.campus_name || '';

    const buffers = [];

    for (const docId of documentIds) {
      if (Date.now() > deadline) {
        throw new Error('Print job timed out');
      }
      try {
        const { buffer, fileName } = await pdfService.getOrGeneratePdf(docId, campusName);
        buffers.push({ buffer, fileName });
      } catch {
        // Individual document failures don't abort the whole job
      }
    }

    if (buffers.length === 0) throw new Error('No PDFs could be generated');

    // Save combined ZIP to campus storage
    const zipDir = path.join(UPLOAD_DIR, campusId || 'global', 'pdf');
    await require('fs').promises.mkdir(zipDir, { recursive: true });
    const zipFileName = `print_job_${jobId}.zip`;
    const zipPath     = path.join(zipDir, zipFileName);

    await new Promise((resolve, reject) => {
      const fs      = require('fs');
      const output  = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      for (const { buffer, fileName } of buffers) {
        archive.append(buffer, { name: fileName });
      }
      archive.finalize();
    });

    job.status      = 'DONE';
    job.downloadUrl = `/api/documents/print-jobs/${jobId}/download`;

  } catch (err) {
    job.status = 'FAILED';
    job.error  = err.message;
  }
};

module.exports = {
  exportPdf,
  exportRaw,
  bulkExport,
  enqueuePrintJob,
  getPrintJobStatus,
};