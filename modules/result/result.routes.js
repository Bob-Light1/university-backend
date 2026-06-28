'use strict';

/**
 * @file result.router.js  (v2)
 * @description Express router for managing academic results.
 *
 *  Registration in server.js :
 *    const resultRouter = require('./modules/result').routes;
 *    app.use('/api/results', resultRouter);
 *
 *  Controllers architecture :
 *  ─────────────────────────────────────────────────────────────────
 *  result.crud.controller.js      → CRUD + CSV import
 *  result.workflow.controller.js  → state workflow + audit
 *  result.analytics.controller.js → transcripts, stats, QR, grading scales
 *  result.helpers.js              → shared helpers (not exported as a route)
 *
 *  Route ordering :
 *  ─────────────────────
 *  Specific named routes (/upload-csv, /campus/overview, etc.)
 *  are declared BEFORE generic routes (/:id) to avoid
 *  Express matching conflicts.
 *
 *  Public route :
 *  ─────────────────────
 *  GET /api/results/verify/:token → without authenticate (QR Code transcripts)
 */

const express = require('express');
const multer  = require('multer');
const router  = express.Router();

const { authenticate, authorize } = require('../../shared/middleware/auth');
const { apiLimiter, uploadLimiter, createCustomLimiter } = require('../../shared/middleware/rate-limiter');

// Public, unauthenticated endpoints below sit BEFORE the global apiLimiter, so
// they need their own limiters or they are wide open to abuse at internet scale.
// verifyResult: read-only token lookup — guard against token brute-forcing.
const verifyLimiter = createCustomLimiter(
  15, 30,
  'Too many verification attempts. Please try again later.',
  { prefix: 'result-verify' }
);
// signTranscript: an unauthenticated write — keep it strict.
const signLimiter = createCustomLimiter(
  60, 10,
  'Too many signature attempts. Please try again later.',
  { prefix: 'result-sign' }
);

// Multer memory — CSV parsed without disk storage
const csvUpload = multer({
  storage:  multer.memoryStorage(),
  limits:   { fileSize: 5 * 1024 * 1024 },  // 5 MB
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'text/csv' || file.originalname.endsWith('.csv');
    ok ? cb(null, true) : cb(new Error('Only CSV files are accepted.'));
  },
});

// ─── IMPORTS CONTROLLERS ──────────────────────────────────────────────────────

const {
  createResult,
  bulkCreateResults,
  uploadResultsCSV,
  getResults,
  getResultById,
  updateResult,
  deleteResult,
} = require('./controllers/result.crud.controller');

const {
  submitResult,
  submitBatch,
  publishResult,
  publishBatch,
  archiveResult,
  lockSemester,
  auditCorrection,
} = require('./controllers/result.workflow.controller');

const {
  getTranscript,
  getFinalTranscript,
  validateTranscript,
  signTranscript,
  getClassStatistics,
  getRetakeList,
  getCampusOverview,
  verifyResult,
  listGradingScales,
  createGradingScale,
  updateGradingScale,
} = require('./controllers/result.analytics.controller');

// ─── ROUTE PUBLIQUE ───────────────────────────────────────────────────────────

/**
 * GET /api/results/verify/:token
 * Authenticity verification of a transcript via QR Code.
 * Without authentication — zero-trust endpoint.
 */
router.get('/verify/:token', verifyLimiter, verifyResult);

/**
 * POST /api/results/final-transcripts/:id/sign
 * Digital signature of the transcript by the parent.
 * Accessible without teacher authentication (the parent identifies with signedBy).
 */
router.post('/final-transcripts/:id/sign', signLimiter, signTranscript);

// ─── MIDDLEWARE GLOBAL ────────────────────────────────────────────────────────

router.use(authenticate);
router.use(apiLimiter);

// ─── GRADING SCALES (before /:id) ────────────────────────────────────────────

/**
 * GET /api/results/grading-scales
 * Lists the active grading scales of the campus.
 */
router.get(
  '/grading-scales',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  listGradingScales
);

/**
 * POST /api/results/grading-scales
 * Creates a new grading scale.
 * Body : { name, system, maxScore, passMark, bands[], isDefault?, description?, schoolCampus? }
 */
router.post(
  '/grading-scales',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  createGradingScale
);

/**
 * PATCH /api/results/grading-scales/:id
 * Updates an existing grading scale.
 */
router.patch(
  '/grading-scales/:id',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  updateGradingScale
);

// ─── ENTRY & IMPORT ──────────────────────────────────────────────────────────

/**
 * POST /api/results/bulk
 * Bulk entry for an entire class.
 * Body : { classId, subjectId, teacherId, evaluationType, evaluationTitle,
 *           academicYear, semester, maxScore, results: [...] }
 */
router.post(
  '/bulk',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  bulkCreateResults
);

/**
 * POST /api/results/upload-csv
 * Bulk import via CSV file (form-data : file + context).
 * CSV columns : studentId, score, coefficient?, teacherRemarks?,
 *                examAttendance?, strengths?, improvements?
 */
router.post(
  '/upload-csv',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  uploadLimiter,
  csvUpload.single('file'),
  uploadResultsCSV
);

// ─── WORKFLOW EN LOT (avant /:id) ─────────────────────────────────────────────

/**
 * POST /api/results/submit-batch
 * Submits in batch all DRAFT of an evaluation → SUBMITTED.
 * Body : { classId, subjectId, evaluationTitle, academicYear, semester }
 */
router.post(
  '/submit-batch',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  submitBatch
);

/**
 * PATCH /api/results/publish-batch
 * Publishes in batch all SUBMITTED → PUBLISHED.
 * Body : { classId, subjectId, evaluationTitle, academicYear, semester }
 */
router.patch(
  '/publish-batch',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  publishBatch
);

/**
 * PATCH /api/results/lock-semester
 * Closes a semester : locking + FinalTranscripts generation.
 * Body : { academicYear, semester, schoolCampus? }
 */
router.patch(
  '/lock-semester',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  lockSemester
);

// ─── AUDIT ────────────────────────────────────────────────────────────────────

/**
 * PATCH /api/results/audit/:id
 * Post-publication correction. ADMIN/DIRECTOR only.
 * Body : { score?, teacherRemarks?, reason (min 10 chars, required) }
 */
router.patch(
  '/audit/:id',
  authorize(['ADMIN', 'DIRECTOR']),
  auditCorrection
);

// ─── ANALYTICS (named routes before /:id) ────────────────────────────────────

/**
 * GET /api/results/campus/overview
 * Global analytics view of the campus.
 * Query : academicYear?, semester?, campusId?
 */
router.get(
  '/campus/overview',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  getCampusOverview
);

/**
 * GET /api/results/transcript/:studentId
 * Complete transcript of a student (computed on the fly).
 * Query : academicYear?
 */
router.get(
  '/transcript/:studentId',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER', 'STUDENT']),
  getTranscript
);

/**
 * GET /api/results/final-transcripts/:studentId
 * Stored final transcript (generated during lockSemester).
 * Query : academicYear, semester
 */
router.get(
  '/final-transcripts/:studentId',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER', 'STUDENT']),
  getFinalTranscript
);

/**
 * POST /api/results/final-transcripts/:id/validate
 * Validates a final transcript DRAFT → VALIDATED (Campus Manager).
 * Body : { decision?, generalAppreciation? }
 */
router.post(
  '/final-transcripts/:id/validate',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  validateTranscript
);

/**
 * GET /api/results/statistics/:classId
 * Statistical distribution of an evaluation (before submission).
 * Query : subjectId, evaluationTitle, academicYear, semester
 */
router.get(
  '/statistics/:classId',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  getClassStatistics
);

/**
 * GET /api/results/retake-list/:classId
 * List of students eligible for retake.
 * Query : subjectId?, academicYear, semester
 */
router.get(
  '/retake-list/:classId',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  getRetakeList
);

// ─── CRUD PRINCIPAL ───────────────────────────────────────────────────────────

/**
 * GET /api/results
 * Paginated list with filters.
 * Query : classId?, subjectId?, teacherId?, studentId?, status?,
 *         evaluationType?, academicYear?, semester?, examPeriod?,
 *         campusId?, page, limit
 */
router.get(
  '/',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER', 'STUDENT']),
  getResults
);

/**
 * POST /api/results
 * Creates an individual result (DRAFT).
 * Body : { student, class, subject, teacher, score, maxScore, coefficient?,
 *           evaluationType, evaluationTitle, academicYear, semester,
 *           examDate?, examPeriod?, examAttendance?,
 *           teacherRemarks?, strengths?, improvements?,
 *           gradingScale?, schoolCampus? }
 */
router.post(
  '/',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  createResult
);

/**
 * GET /api/results/:id
 * Full detail with audit log and pedagogical feedback.
 */
router.get(
  '/:id',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER', 'STUDENT']),
  getResultById
);

/**
 * PUT /api/results/:id
 * Updates a DRAFT or SUBMITTED result (with appropriate rights).
 * Uses result.canModify(role, userId) [S3-1].
 */
router.put(
  '/:id',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  updateResult
);

/**
 * DELETE /api/results/:id
 * Soft-delete (DRAFT only for non-admin).
 */
router.delete(
  '/:id',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  deleteResult
);

// ─── WORKFLOW INDIVIDUEL ──────────────────────────────────────────────────────

/**
 * POST /api/results/:id/submit
 * Submits a result DRAFT → SUBMITTED.
 */
router.post(
  '/:id/submit',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  submitResult
);

/**
 * PATCH /api/results/:id/publish
 * Publishes a result SUBMITTED → PUBLISHED.
 * Triggers dropout risk computation.
 * [S3-2] Transaction for RETAKE.
 */
router.patch(
  '/:id/publish',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  publishResult
);

/**
 * PATCH /api/results/:id/archive
 * Archives a result PUBLISHED → ARCHIVED.
 */
router.patch(
  '/:id/archive',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  archiveResult
);

module.exports = router;