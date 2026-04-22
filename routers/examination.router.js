'use strict';

/**
 * @file examination.router.js
 * @description Express router for SEMS — Smart Examination Management System.
 *
 *  Registration in server.js:
 *    const examinationRouter = require('./routers/examination.router');
 *    app.use('/api/examination', examinationRouter);
 *
 *  Resource groups and prefixes:
 *  ─────────────────────────────────────────────────────────────────────────────
 *  Question Bank   →  /api/examination/questions
 *  Sessions        →  /api/examination/sessions
 *  Enrollments     →  /api/examination/enrollments
 *  Delivery        →  /api/examination/delivery  (submission-scoped runtime)
 *  Grading         →  /api/examination/grading
 *  Appeals         →  /api/examination/appeals
 *  Analytics       →  /api/examination/analytics
 *  Certificates    →  /api/examination/certificates
 *
 *  Public routes (no authenticate middleware):
 *    GET  /api/examination/certificates/:token/verify
 *
 *  Named routes are declared BEFORE generic /:id routes to avoid Express
 *  matching conflicts.
 */

const express = require('express');
const router  = express.Router();

const { authenticate, authorize } = require('../middleware/auth/auth');
const { apiLimiter }              = require('../middleware/rate-limiter/rate-limiter');

// ─── Controller imports ───────────────────────────────────────────────────────

const {
  listQuestions,
  createQuestion,
  getQuestion,
  updateQuestion,
  deleteQuestion,
  importQuestions,
  getQuestionStats,
} = require('../controllers/exam-controllers/exam.questionBank.controller');

const {
  listSessions,
  createSession,
  getSession,
  updateSession,
  deleteSession,
  submitSession,
  approveSession,
  publishSession,
  startSession,
  completeSession,
  cancelSession,
  postponeSession,
} = require('../controllers/exam-controllers/exam.session.controller');

const {
  computeEligibility,
  listEnrollments,
  getEnrollment,
  updateEnrollment,
  deleteEnrollment,
  generateHallTickets,
  getHallTicket,
  checkIn,
} = require('../controllers/exam-controllers/exam.enrollment.controller');

const {
  startAttempt,
  getQuestions,
  saveAnswer,
  submitExam,
  logAntiCheat,
  getSubmission,
} = require('../controllers/exam-controllers/exam.delivery.controller');

const {
  listGradings,
  getGrading,
  gradingQueue,
  gradeSubmission,
  updateGrading,
  assignSecondGrader,
  submitSecondGrade,
  mediate,
  publishGrades,
} = require('../controllers/exam-controllers/exam.grading.controller');

const {
  submitAppeal,
  listAppeals,
  reviewAppeal,
  resolveAppeal,
} = require('../controllers/exam-controllers/exam.appeal.controller');

const {
  campusOverview,
  getSnapshot,
  itemAnalysis,
  earlyWarning,
  exportReport,
} = require('../controllers/exam-controllers/exam.analytics.controller');

const {
  generateCertificate,
  verifyCertificate,
} = require('../controllers/exam-controllers/exam.certificate.controller');

// ─── Public routes (no auth) ──────────────────────────────────────────────────

/**
 * GET /api/examination/certificates/:token/verify
 * Public QR-code verification — no authentication required.
 */
router.get('/certificates/:token/verify', verifyCertificate);

// ─── Global middleware (all routes below require authentication) ───────────────

router.use(authenticate);
router.use(apiLimiter);

// ═══════════════════════════════════════════════════════════════════════════════
// QUESTION BANK  /questions
// ═══════════════════════════════════════════════════════════════════════════════

router.get(
  '/questions',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  listQuestions
);

router.post(
  '/questions',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  createQuestion
);

/**
 * POST /api/examination/questions/import
 * Must be declared BEFORE /questions/:id to avoid Express conflict.
 */
router.post(
  '/questions/import',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  importQuestions
);

router.get(
  '/questions/:id',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  getQuestion
);

router.patch(
  '/questions/:id',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  updateQuestion
);

router.delete(
  '/questions/:id',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  deleteQuestion
);

router.get(
  '/questions/:id/stats',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  getQuestionStats
);

// ═══════════════════════════════════════════════════════════════════════════════
// SESSIONS  /sessions
// ═══════════════════════════════════════════════════════════════════════════════

router.get(
  '/sessions',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER', 'STUDENT']),
  listSessions
);

/**
 * POST /api/examination/sessions
 * Create a new exam session (status DRAFT).
 */
router.post(
  '/sessions',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  createSession
);

router.get(
  '/sessions/:id',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER', 'STUDENT']),
  getSession
);

router.patch(
  '/sessions/:id',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  updateSession
);

router.delete(
  '/sessions/:id',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  deleteSession
);

// ── Session lifecycle transitions ─────────────────────────────────────────────

/**
 * PATCH /api/examination/sessions/:id/submit
 * DRAFT → SCHEDULED (teacher/manager submits for scheduling).
 */
router.patch(
  '/sessions/:id/submit',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  submitSession
);

/**
 * PATCH /api/examination/sessions/:id/approve
 * DRAFT → SCHEDULED (manager formal approval step).
 */
router.patch(
  '/sessions/:id/approve',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  approveSession
);

/**
 * PATCH /api/examination/sessions/:id/publish
 * DRAFT → SCHEDULED with publishedAt timestamp (makes session visible to students).
 */
router.patch(
  '/sessions/:id/publish',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  publishSession
);

/**
 * PATCH /api/examination/sessions/:id/start
 * SCHEDULED → ONGOING.
 */
router.patch(
  '/sessions/:id/start',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  startSession
);

/**
 * PATCH /api/examination/sessions/:id/complete
 * ONGOING → COMPLETED — triggers async analytics snapshot.
 */
router.patch(
  '/sessions/:id/complete',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  completeSession
);

/**
 * PATCH /api/examination/sessions/:id/cancel
 * Body: { reason }
 */
router.patch(
  '/sessions/:id/cancel',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  cancelSession
);

/**
 * PATCH /api/examination/sessions/:id/postpone
 * Body: { startTime, endTime, reason }
 */
router.patch(
  '/sessions/:id/postpone',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  postponeSession
);

/**
 * POST /api/examination/sessions/:id/start-attempt
 * Student begins their exam attempt. Returns submissionId.
 */
router.post(
  '/sessions/:id/start-attempt',
  authorize(['STUDENT']),
  startAttempt
);

/**
 * GET /api/examination/sessions/:id/hall-tickets
 * Bulk hall-ticket data for all eligible students in a session.
 */
router.get(
  '/sessions/:id/hall-tickets',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  generateHallTickets
);

// ═══════════════════════════════════════════════════════════════════════════════
// ENROLLMENTS  /enrollments
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/examination/enrollments/compute
 * Batch compute eligibility. Body: { sessionId }
 * Must be before /enrollments/:id to avoid param collision.
 */
router.post(
  '/enrollments/compute',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  computeEligibility
);

/**
 * POST /api/examination/enrollments/check-in
 * Validate hall-ticket UUID token and mark attendance.
 * Body: { token, sessionId }
 */
router.post(
  '/enrollments/check-in',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  checkIn
);

/**
 * GET /api/examination/enrollments
 * Query: sessionId (required), isEligible?, attendance?, page, limit
 */
router.get(
  '/enrollments',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  listEnrollments
);

router.get(
  '/enrollments/:id',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER', 'STUDENT']),
  getEnrollment
);

/**
 * GET /api/examination/enrollments/:id/hall-ticket
 * Student fetches own ticket; managers can access any.
 */
router.get(
  '/enrollments/:id/hall-ticket',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER', 'STUDENT']),
  getHallTicket
);

router.patch(
  '/enrollments/:id',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  updateEnrollment
);

router.delete(
  '/enrollments/:id',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  deleteEnrollment
);

// ═══════════════════════════════════════════════════════════════════════════════
// DELIVERY  /delivery  (submission-scoped exam runtime)
// ─── All :id params refer to the ExamSubmission._id (submissionId) ────────────
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/examination/delivery/:id/questions
 * Returns the student's personalised (seeded-shuffle) question list.
 * Correct answers are stripped for IN_PROGRESS submissions.
 */
router.get(
  '/delivery/:id/questions',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER', 'STUDENT']),
  getQuestions
);

/**
 * PATCH /api/examination/delivery/:id/answers
 * Auto-save one answer. Body: { questionId, selectedOption?, openText?, fileUrl? }
 */
router.patch(
  '/delivery/:id/answers',
  authorize(['STUDENT']),
  saveAnswer
);

/**
 * POST /api/examination/delivery/:id/submit
 * Final submission — triggers non-blocking MCQ auto-grading.
 */
router.post(
  '/delivery/:id/submit',
  authorize(['STUDENT']),
  submitExam
);

/**
 * POST /api/examination/delivery/:id/anti-cheat
 * Log a client-side anti-cheat event. Body: { type, detail? }
 */
router.post(
  '/delivery/:id/anti-cheat',
  authorize(['STUDENT']),
  logAntiCheat
);

/**
 * GET /api/examination/delivery/:id/submission
 * Retrieve submission details (students see results after publication).
 */
router.get(
  '/delivery/:id/submission',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER', 'STUDENT']),
  getSubmission
);

// ═══════════════════════════════════════════════════════════════════════════════
// GRADING  /grading
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/examination/grading/queue
 * Grading queue for a session. Query: sessionId (required), page, limit
 * Must be before /grading/:id to avoid param collision.
 */
router.get(
  '/grading/queue',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  gradingQueue
);

/**
 * POST /api/examination/grading/publish
 * Bulk publish GRADED|MEDIATED → PUBLISHED. Body: { sessionId }
 * Must be before /grading/:id to avoid param collision.
 */
router.post(
  '/grading/publish',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  publishGrades
);

/**
 * GET /api/examination/grading
 * List gradings. Query: sessionId?, status?, grader?, page, limit
 */
router.get(
  '/grading',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  listGradings
);

/**
 * POST /api/examination/grading
 * Grade a submission. Body: { submissionId, score, rubricScores?, graderFeedback?, annotations?, isBlindGrading? }
 */
router.post(
  '/grading',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  gradeSubmission
);

router.get(
  '/grading/:id',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER', 'STUDENT']),
  getGrading
);

/**
 * PATCH /api/examination/grading/:id
 * Update grading fields before publication.
 */
router.patch(
  '/grading/:id',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  updateGrading
);

/**
 * PATCH /api/examination/grading/:id/second-grader
 * Assign a second grader for double-blind review. Body: { teacherId }
 */
router.patch(
  '/grading/:id/second-grader',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  assignSecondGrader
);

/**
 * PATCH /api/examination/grading/:id/second-grade
 * Submit second grader's score. Body: { secondScore }
 */
router.patch(
  '/grading/:id/second-grade',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  submitSecondGrade
);

/**
 * PATCH /api/examination/grading/:id/mediate
 * Mediator resolves discrepancy. Body: { mediatorScore }
 */
router.patch(
  '/grading/:id/mediate',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  mediate
);

// ═══════════════════════════════════════════════════════════════════════════════
// APPEALS  /appeals
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/examination/appeals
 * Student submits a grade appeal. Body: { gradingId, reason (min 20 chars), attachments? }
 */
router.post(
  '/appeals',
  authorize(['STUDENT']),
  submitAppeal
);

/**
 * GET /api/examination/appeals
 * List appeals. Query: status?, page, limit
 */
router.get(
  '/appeals',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  listAppeals
);

/**
 * PATCH /api/examination/appeals/:id/review
 * Move appeal PENDING → UNDER_REVIEW.
 */
router.patch(
  '/appeals/:id/review',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  reviewAppeal
);

/**
 * PATCH /api/examination/appeals/:id/resolve
 * Resolve or reject. Body: { decision: 'RESOLVED'|'REJECTED', resolution, newScore? }
 */
router.patch(
  '/appeals/:id/resolve',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  resolveAppeal
);

// ═══════════════════════════════════════════════════════════════════════════════
// ANALYTICS  /analytics
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/examination/analytics/campus-overview
 * Query: academicYear?, semester?, examPeriod?
 */
router.get(
  '/analytics/campus-overview',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  campusOverview
);

/**
 * GET /api/examination/analytics/early-warning
 * Query: academicYear?, page, limit
 */
router.get(
  '/analytics/early-warning',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  earlyWarning
);

/**
 * GET /api/examination/analytics/export
 * Query: academicYear (required), format? ('json'|'csv')
 */
router.get(
  '/analytics/export',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  exportReport
);

/**
 * GET /api/examination/analytics/sessions/:id/snapshot
 */
router.get(
  '/analytics/sessions/:id/snapshot',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  getSnapshot
);

/**
 * GET /api/examination/analytics/sessions/:id/item-analysis
 */
router.get(
  '/analytics/sessions/:id/item-analysis',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  itemAnalysis
);

// ═══════════════════════════════════════════════════════════════════════════════
// CERTIFICATES  /certificates
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/examination/certificates/generate/:gradingId
 * Generate (or retrieve existing) UUID certificate token for a PUBLISHED grading.
 */
router.post(
  '/certificates/generate/:gradingId',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  generateCertificate
);

// ─── (verifyCertificate is registered above as a public route) ────────────────

module.exports = router;
