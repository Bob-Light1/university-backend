'use strict';

/**
 * @file document.router.js
 * @description Express router for the Document Management Module.
 *
 * All routes prefixed with /api/documents (registered in server.js).
 *
 * Security layers applied per route group:
 *   1. authenticate          — JWT verification
 *   2. enforceCampusAccess   — campusId extraction (Layer 1)
 *   3. loadAndVerifyDocument — per-doc campus cross-check (Layer 3, only on /:id routes)
 *   4. enforceDocumentTypeAccess — TEACHER type guard (Layer B)
 *   5. Role-specific scope middleware (enforceTeacherScope, enforceStudentScope, enforceParentScope)
 *   6. enforceDocumentStorageQuota — quota check on upload/create operations
 *
 * Rate limiters applied:
 *   - apiLimiter:             standard routes
 *   - pdfLimiter:             PDF export and print (5 req/min per user)
 *   - shareLimiter:           public share access (10 req/min per IP)
 *   - verifyLimiter:          public verify endpoint (10 req/min per IP)
 *
 * File upload:
 *   - documentUpload:         multer instance configured for document MIME types (up to 25 MB)
 */

const express  = require('express');
const rateLimit        = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const multer    = require('multer');

const router = express.Router();

// ── Existing platform middleware ──────────────────────────────────────────────
const { authenticate }    = require('../../shared/middleware/auth');
const { apiLimiter }      = require('../../shared/middleware/rate-limiter');
const { hardDeleteFlagLimiter } = require('../../shared/lib/hard-delete');

// ── Document-module middleware ────────────────────────────────────────────────
const {
  enforceCampusAccess,
  enforceCampusStorageQuota,
} = require('./middleware/document.campus.middleware');

const {
  loadAndVerifyDocument,
  enforceDocumentTypeAccess,
  enforceTeacherScope,
  enforceStudentScope,
  enforceParentScope,
  enforceLockGuard,
  requireDocRole,
} = require('./middleware/document.access.middleware');

// ── Controllers ───────────────────────────────────────────────────────────────
const crudCtrl     = require('./controllers/document.crud.controller');
const workflowCtrl = require('./controllers/document.workflow.controller');
const exportCtrl   = require('./controllers/document.export.controller');
const templateCtrl = require('./controllers/document.template.controller');
const shareCtrl    = require('./controllers/document.share.controller');
const auditCtrl    = require('./controllers/document.audit.controller');

// ── Rate limiters ─────────────────────────────────────────────────────────────

/** PDF export / print: 5 requests per minute per authenticated user */
const pdfLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             5,
  // Prefer the authenticated user's id for keying; fall back to normalized IP
  // (ipKeyGenerator handles IPv6 normalization — required by express-rate-limit v7+).
  keyGenerator:    (req) => req.user?.id ?? ipKeyGenerator(req),
  standardHeaders: true,
  legacyHeaders:   false,
  handler:         (req, res) => res.status(429).json({
    success: false,
    message: 'PDF generation rate limit exceeded. Please wait before retrying.',
    retryAfter: 60,
  }),
});

/** Public share access: 10 requests per minute per IP */
const shareLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             10,
  // ipKeyGenerator normalizes IPv6 addresses to prevent limit bypass (required v7+)
  keyGenerator:    (req) => ipKeyGenerator(req),
  standardHeaders: true,
  legacyHeaders:   false,
  handler:         (req, res) => res.status(429).json({
    success: false,
    message: 'Too many share link requests from this IP.',
    retryAfter: 60,
  }),
});

/** Public document verification: 10 requests per minute per IP */
const verifyLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             10,
  // ipKeyGenerator normalizes IPv6 addresses to prevent limit bypass (required v7+)
  keyGenerator:    (req) => ipKeyGenerator(req),
  standardHeaders: true,
  legacyHeaders:   false,
  handler:         (req, res) => res.status(429).json({
    success: false,
    message: 'Too many verification requests from this IP.',
    retryAfter: 60,
  }),
});

// ── Multer — document uploads ─────────────────────────────────────────────────

const ALLOWED_MIMES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'image/jpeg', 'image/png', 'image/webp', 'image/svg+xml',
  'text/plain', 'text/csv', 'text/markdown',
];

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: parseInt(process.env.DOC_UPLOAD_MAX_SIZE_MB || '25', 10) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(Object.assign(new Error(`Unsupported file type: ${file.mimetype}`), { statusCode: 422 }));
    }
  },
});

// ── Shared auth+campus stack ──────────────────────────────────────────────────

/** Applied to all authenticated routes */
const base = [authenticate, apiLimiter, enforceCampusAccess];

/** Applied to routes that require loading and verifying a specific document */
const withDoc = [
  ...base,
  loadAndVerifyDocument,
];

/**
 * Per-role scope guards. Each is a no-op for every role but its own, so the three travel
 * together: naming the set once is what stops a route from carrying two of the three.
 *
 * They answer "may this identity touch THIS document", which a campus filter cannot: a
 * TEACHER and a STUDENT of the same campus both pass Layer 3 and must still be held to
 * their own course materials / their own records.
 */
const docScopeGuards = [
  enforceTeacherScope,
  enforceStudentScope,
  enforceParentScope,
];

/**
 * Roles that may modify a document. STUDENT and PARENT hold read-only access to the GED —
 * stated here rather than left to the scope guards, which only narrow WHICH documents a
 * role sees and would happily let a student edit a transcript that is linked to them.
 */
const DOCUMENT_WRITE_ROLES = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER'];

/** Applied to routes that allow TEACHER scope access (read-only on their course materials) */
const withDocTeacher = [
  ...withDoc,
  enforceDocumentTypeAccess,
  ...docScopeGuards,
];

// ── PUBLIC ROUTES (no authentication) ────────────────────────────────────────

/**
 * GET /api/documents/share/:token
 * Public share link access — rate limited, no auth required.
 */
router.get('/share/:token', shareLimiter, shareCtrl.accessSharedDocument);

/**
 * GET /api/documents/verify/:ref
 * Public QR code document verification — rate limited, no auth required.
 * Returns: { valid, title, type, campusName, issuedAt, status } — never exposes content.
 */
router.get('/verify/:ref', verifyLimiter, async (req, res) => {
  try {
    const Document = require('./models/document.model');
    const { getCampusName } = require('../campus').service; // campus module facade (§3)
    const { sendSuccess, sendNotFound } = require('../../shared/utils/response-helpers');

    const doc = await Document
      .findOne({ ref: req.params.ref.toUpperCase(), deletedAt: null })
      .select('title type status campusId publishedAt isOfficial')
      .lean();

    if (!doc) return sendNotFound(res, 'Document');

    const campus = await getCampusName(doc.campusId);

    return sendSuccess(res, 200, 'Document verified', {
      valid:      true,
      ref:        req.params.ref.toUpperCase(),
      title:      doc.title,
      type:       doc.type,
      campusName: campus?.campus_name || '',
      issuedAt:   doc.publishedAt,
      status:     doc.status,
      isOfficial: doc.isOfficial,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

// ── SEARCH ────────────────────────────────────────────────────────────────────

/**
 * GET /api/documents/search
 * Full-text search with metadata filters.
 */
router.get('/search', ...base, async (req, res) => {
  const documentService = require('./services/document.service');
  const { sendPaginated } = require('../../shared/utils/response-helpers');
  const { data, total, page, limit } = await documentService.searchDocuments(req, req.query);
  return sendPaginated(res, 200, 'Search results', data, { total, page, limit });
});

// ── AUDIT: CAMPUS-WIDE ────────────────────────────────────────────────────────

router.get('/audit/campus', ...base, auditCtrl.getCampusAudit);

// ── TEMPLATES ─────────────────────────────────────────────────────────────────

router.post('/templates',         ...base, templateCtrl.createTemplate);
router.get('/templates',          ...base, templateCtrl.listTemplates);
router.get('/templates/:id',      ...base, templateCtrl.getTemplate);
router.patch('/templates/:id',    ...base, templateCtrl.updateTemplate);
router.delete('/templates/:id',   ...base, templateCtrl.deleteTemplate);
router.post('/templates/:id/generate', ...base, templateCtrl.generateFromTemplate);
router.post('/templates/:id/preview',  ...base, templateCtrl.previewTemplate);

// ── TYPED GENERATION ──────────────────────────────────────────────────────────

router.post('/generate/student-card/:studentId',       ...base, templateCtrl.generateStudentCard);
router.post('/generate/student-transcript/:studentId', ...base, async (req, res) => {
  // Transcript generation delegated to template with student data — Phase 2
  const { sendError } = require('../../shared/utils/response-helpers');
  return sendError(res, 501, 'Student transcript generation will be available in Phase 2');
});
router.post('/generate/teacher-payslip/:teacherId',    ...base, templateCtrl.generateTeacherPayslip);
router.post('/generate/class-list/:classId',           ...base, templateCtrl.generateClassList);
router.post('/generate/badge/:entityType/:entityId',   ...base, async (req, res) => {
  const { sendError } = require('../../shared/utils/response-helpers');
  return sendError(res, 501, 'Badge generation will be available in Phase 2');
});

// ── BULK OPERATIONS ───────────────────────────────────────────────────────────

router.post('/bulk/export', ...base, pdfLimiter, exportCtrl.bulkExport);
router.post('/bulk/print',  ...base, pdfLimiter, exportCtrl.enqueuePrintJob);
router.get('/print-jobs/:jobId/download', ...base, exportCtrl.downloadPrintJob);
router.get('/print-jobs/:jobId', ...base, exportCtrl.getPrintJobStatus);

// ── CRUD ──────────────────────────────────────────────────────────────────────

/**
 * POST /api/documents
 * Create rich-content document OR import an external file.
 * documentUpload middleware processes the file only when Content-Type is multipart/form-data.
 */
router.post(
  '/',
  ...base,
  enforceCampusStorageQuota,
  // Parse multipart/form-data BEFORE enforceDocumentTypeAccess so that
  // req.body is always populated when the type guard reads req.body.type.
  documentUpload.single('file'),
  enforceDocumentTypeAccess,
  crudCtrl.createDocument,
);

/**
 * GET /api/documents — list with filters and pagination.
 * `deleted=true` returns the trash (soft-deleted documents only), ADMIN / DIRECTOR only.
 */
router.get('/', ...base, crudCtrl.listDocuments);

/** GET /api/documents/:id — single document with full body */
router.get('/:id', ...withDocTeacher, crudCtrl.getDocument);

/**
 * PATCH /api/documents/:id — partial update.
 *
 * Middleware order is load-bearing, for the same reason spelled out on POST above:
 * `enforceDocumentTypeAccess` reads `req.body.type`, and on a multipart/form-data request
 * `req.body` does not exist until multer has parsed it. Running the guard first made it
 * fall back to the type of the document ALREADY stored — so a TEACHER retyping a
 * COURSE_MATERIAL into a restricted type was refused when the request was JSON and
 * accepted when the identical request was sent as multipart. Two answers to one question,
 * chosen by Content-Type.
 *
 * Everything that can refuse without reading the body still runs before multer, so an
 * unauthorized caller is turned away without a 25 MB upload being parsed first.
 */
router.patch(
  '/:id',
  ...withDoc,
  requireDocRole(DOCUMENT_WRITE_ROLES),
  ...docScopeGuards,
  enforceLockGuard,
  documentUpload.single('file'),
  enforceDocumentTypeAccess,
  crudCtrl.updateDocument,
);

/**
 * DELETE /api/documents/:id — soft or hard delete.
 * `hardDeleteFlagLimiter` meters ONLY the `?hard=true` form, on the same budget as the
 * danger-zone router: both reach the same password control, so metering one of the two
 * alone is a limit an attacker skips by changing URL. Soft deletes stay unmetered.
 *
 * Carries the same role gate and scope guards as PATCH: deletion is a write, and this
 * route reached `softDeleteDocument` — which checks the status but never the identity —
 * with nothing between it and any authenticated member of the campus.
 */
router.delete(
  '/:id',
  ...withDoc,
  requireDocRole(DOCUMENT_WRITE_ROLES),
  ...docScopeGuards,
  enforceLockGuard,
  hardDeleteFlagLimiter,
  crudCtrl.deleteDocument,
);

// ── WORKFLOW ──────────────────────────────────────────────────────────────────

router.post('/:id/publish',       ...base, loadAndVerifyDocument, workflowCtrl.publishDocument);
router.post('/:id/archive',       ...base, loadAndVerifyDocument, workflowCtrl.archiveDocument);
router.post('/:id/restore',       ...base, loadAndVerifyDocument, workflowCtrl.restoreDocument);
router.post('/:id/duplicate',     ...base, loadAndVerifyDocument, workflowCtrl.duplicateDocument);
router.post('/:id/lock',          ...base, loadAndVerifyDocument, workflowCtrl.lockDocument);
router.post('/:id/unlock',        ...base, loadAndVerifyDocument, workflowCtrl.unlockDocument);
router.post('/:id/mark-official', ...base, loadAndVerifyDocument, workflowCtrl.markOfficial);

// ── EXPORT ────────────────────────────────────────────────────────────────────

router.get('/:id/export/pdf', ...withDocTeacher, pdfLimiter, exportCtrl.exportPdf);
router.get('/:id/export/raw', ...withDocTeacher, exportCtrl.exportRaw);

// ── SHARE ─────────────────────────────────────────────────────────────────────

router.post('/:id/share',         ...base, loadAndVerifyDocument, shareCtrl.createShareLink);
router.get('/:id/shares',         ...base, loadAndVerifyDocument, shareCtrl.listShareLinks);
router.delete('/share/:shareId',  ...base, shareCtrl.revokeShareLink);

// ── AUDIT ─────────────────────────────────────────────────────────────────────

router.get('/:id/audit', ...base, loadAndVerifyDocument, auditCtrl.getDocumentAudit);

// ── VERSIONS ──────────────────────────────────────────────────────────────────

router.get('/:id/versions',                        ...base, loadAndVerifyDocument, auditCtrl.listVersions);
router.get('/:id/versions/:version',               ...base, loadAndVerifyDocument, auditCtrl.getVersion);
router.post('/:id/versions/:version/restore',      ...base, loadAndVerifyDocument, auditCtrl.restoreVersion);

module.exports = router;