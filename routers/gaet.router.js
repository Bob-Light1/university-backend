'use strict';

/**
 * @file gaet.router.js
 * @description Express router for GAET — Générateur Automatique d'Emploi du Temps.
 *
 *  Base path (registered in server.js):
 *    /api/gaet
 *
 *  Access policy:
 *  ─────────────────────────────────────────────────────────────────────────────
 *  • READ (constraints, status, preview, conflicts):
 *      ADMIN / DIRECTOR / CAMPUS_MANAGER — oversight + operational monitoring.
 *
 *  • WRITE (create/update constraints, generate, publish, cancel):
 *      CAMPUS_MANAGER only — campus-level operational action.
 *      ADMIN / DIRECTOR use oversight reads; they do not operate a specific campus.
 *
 *  Campus isolation:
 *      Every controller action calls getCampusFilter() which wraps buildCampusFilter().
 *      Non-global roles are locked to their JWT campusId — req.body.campusId is never
 *      trusted for writes.
 */

const express = require('express');
const router  = express.Router();

const { authenticate, authorize } = require('../middleware/auth/auth');
const { apiLimiter, strictLimiter } = require('../middleware/rate-limiter/rate-limiter');

const {
  validateConstraintBody,
  validateGenerateBody,
} = require('../validations/gaet.constraint.schema');

const {
  getConstraints,
  createOrUpdateConstraints,
  generateSchedule,
  getStatus,
  getPreview,
  publishSchedule,
  getConflicts,
  cancelGenerated,
} = require('../controllers/gaet.controller');

// ─────────────────────────────────────────────
// GLOBAL MIDDLEWARE
// ─────────────────────────────────────────────

router.use(authenticate);
router.use(apiLimiter);

// ─────────────────────────────────────────────
// READ — constraints + monitoring
// ─────────────────────────────────────────────

/**
 * GET /api/gaet/constraints/:campusId
 * Returns the active GaetConstraint for a campus + semester.
 * Query: academicYear, semester
 */
router.get(
  '/constraints/:campusId',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  getConstraints
);

/**
 * GET /api/gaet/status/:constraintId
 * Returns current status + qualityReport (used by frontend polling).
 */
router.get(
  '/status/:constraintId',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  getStatus
);

/**
 * GET /api/gaet/preview/:constraintId
 * Returns generatedSessions before publication (read-only preview).
 */
router.get(
  '/preview/:constraintId',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  getPreview
);

/**
 * GET /api/gaet/conflicts/:constraintId
 * Returns unplacedCourses with reasons from the qualityReport.
 */
router.get(
  '/conflicts/:constraintId',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  getConflicts
);

// ─────────────────────────────────────────────
// WRITE — campus manager operations
// ─────────────────────────────────────────────

/**
 * POST /api/gaet/constraints
 * Create or update (upsert) the GaetConstraint for a campus + semester.
 * Body: { academicYear, semester, timeSlots?, courseRequirements?, roomRegistry?, teacherPreferences? }
 */
router.post(
  '/constraints',
  authorize(['CAMPUS_MANAGER']),
  validateConstraintBody,
  createOrUpdateConstraints
);

/**
 * POST /api/gaet/generate
 * Trigger timetable generation in a worker thread (returns 202 immediately).
 * Body: { academicYear, semester }
 * Rate-limited to 3 per hour — generation is CPU-heavy.
 */
router.post(
  '/generate',
  authorize(['CAMPUS_MANAGER']),
  strictLimiter,
  validateGenerateBody,
  generateSchedule
);

/**
 * POST /api/gaet/publish/:constraintId
 * Publish a GENERATED timetable → creates StudentSchedule docs + syncs TeacherSchedule.
 * Only works when status is GENERATED or PARTIALLY_GENERATED.
 */
router.post(
  '/publish/:constraintId',
  authorize(['CAMPUS_MANAGER']),
  publishSchedule
);

/**
 * DELETE /api/gaet/generated/:constraintId
 * Cancel a generated (not yet published) timetable — resets status to DRAFT.
 * Cannot cancel a PUBLISHED timetable (use the schedule cancellation flow instead).
 */
router.delete(
  '/generated/:constraintId',
  authorize(['CAMPUS_MANAGER']),
  cancelGenerated
);

module.exports = router;
