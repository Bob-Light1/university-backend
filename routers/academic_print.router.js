'use strict';

/**
 * @file academic_print.router.js
 * @description Express router for the Academic Print Module.
 *
 * Base path (registered in server.js):
 *   /api/print
 *
 * All routes require authentication.
 * Campus managers, admins, and directors can generate and download documents.
 */

const express = require('express');
const router  = express.Router();

const { authenticate, authorize } = require('../middleware/auth/auth');
const { apiLimiter }              = require('../middleware/rate-limiter/rate-limiter');

const {
  previewPdf,
  listJobs,
  startBatch,
  getBatchJobStatus,
  downloadBatchResult,
} = require('../controllers/academic_print.controller');

// ── Global middleware ─────────────────────────────────────────────────────────
router.use(authenticate);
router.use(apiLimiter);

const MANAGERS = ['CAMPUS_MANAGER', 'ADMIN', 'DIRECTOR'];

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/print/preview
 * Stream a single PDF preview (not saved to disk).
 * Body: { type, studentId?, classId?, params }
 */
router.post('/preview', authorize(MANAGERS), previewPdf);

/**
 * GET /api/print/jobs
 * List batch print jobs for the campus (paginated).
 */
router.get('/jobs', authorize(MANAGERS), listJobs);

/**
 * POST /api/print/batch
 * Enqueue a batch job for a class or list of students.
 * Body: { type, classId?, studentIds?, params }
 */
router.post('/batch', authorize(MANAGERS), startBatch);

/**
 * GET /api/print/batch/:jobId
 * Get status, progress and results of a batch job.
 */
router.get('/batch/:jobId', authorize(MANAGERS), getBatchJobStatus);

/**
 * GET /api/print/batch/:jobId/download/:fileName
 * Stream a result PDF from a completed batch job.
 */
router.get('/batch/:jobId/download/:fileName', authorize(MANAGERS), downloadBatchResult);

module.exports = router;
