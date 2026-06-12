'use strict';

/**
 * @file result.router.js  (v2)
 * @description Router Express pour la gestion des résultats académiques.
 *
 *  Enregistrement dans server.js :
 *    const resultRouter = require('./modules/result').routes;
 *    app.use('/api/results', resultRouter);
 *
 *  Architecture des controllers :
 *  ─────────────────────────────────────────────────────────────────
 *  result.crud.controller.js      → CRUD + import CSV
 *  result.workflow.controller.js  → workflow d'état + audit
 *  result.analytics.controller.js → transcripts, stats, QR, barèmes
 *  result.helpers.js              → helpers partagés (non-exporté en route)
 *
 *  Ordre des routes :
 *  ─────────────────────
 *  Les routes nommées spécifiques (/upload-csv, /campus/overview, etc.)
 *  sont déclarées AVANT les routes génériques (/:id) pour éviter les
 *  conflits de matching Express.
 *
 *  Route publique :
 *  ─────────────────────
 *  GET /api/results/verify/:token → sans authenticate (QR Code bulletins)
 */

const express = require('express');
const multer  = require('multer');
const router  = express.Router();

const { authenticate, authorize } = require('../../shared/middleware/auth');
const { apiLimiter, uploadLimiter } = require('../../shared/middleware/rate-limiter');

// Multer mémoire — CSV parsé sans stockage disque
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
 * Vérification d'authenticité d'un bulletin via QR Code.
 * Sans authentification — endpoint de confiance zéro.
 */
router.get('/verify/:token', verifyResult);

/**
 * POST /api/results/final-transcripts/:id/sign
 * Signature numérique du bulletin par le parent.
 * Accessible sans authentification enseignant (le parent s'identifie avec signedBy).
 */
router.post('/final-transcripts/:id/sign', signTranscript);

// ─── MIDDLEWARE GLOBAL ────────────────────────────────────────────────────────

router.use(authenticate);
router.use(apiLimiter);

// ─── BARÈMES DE NOTATION (avant /:id) ────────────────────────────────────────

/**
 * GET /api/results/grading-scales
 * Liste les barèmes actifs du campus.
 */
router.get(
  '/grading-scales',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  listGradingScales
);

/**
 * POST /api/results/grading-scales
 * Crée un nouveau barème.
 * Body : { name, system, maxScore, passMark, bands[], isDefault?, description?, schoolCampus? }
 */
router.post(
  '/grading-scales',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  createGradingScale
);

/**
 * PATCH /api/results/grading-scales/:id
 * Met à jour un barème existant.
 */
router.patch(
  '/grading-scales/:id',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  updateGradingScale
);

// ─── SAISIE & IMPORT ─────────────────────────────────────────────────────────

/**
 * POST /api/results/bulk
 * Saisie massive pour une classe entière.
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
 * Import massif via fichier CSV (form-data : file + contexte).
 * Colonnes CSV : studentId, score, coefficient?, teacherRemarks?,
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
 * Soumet en lot tous les DRAFT d'une évaluation → SUBMITTED.
 * Body : { classId, subjectId, evaluationTitle, academicYear, semester }
 */
router.post(
  '/submit-batch',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  submitBatch
);

/**
 * PATCH /api/results/publish-batch
 * Publie en lot tous les SUBMITTED → PUBLISHED.
 * Body : { classId, subjectId, evaluationTitle, academicYear, semester }
 */
router.patch(
  '/publish-batch',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  publishBatch
);

/**
 * PATCH /api/results/lock-semester
 * Clôture un semestre : verrouillage + génération FinalTranscripts.
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
 * Correction post-publication. ADMIN/DIRECTOR uniquement.
 * Body : { score?, teacherRemarks?, reason (min 10 chars, obligatoire) }
 */
router.patch(
  '/audit/:id',
  authorize(['ADMIN', 'DIRECTOR']),
  auditCorrection
);

// ─── ANALYTICS (routes nommées avant /:id) ────────────────────────────────────

/**
 * GET /api/results/campus/overview
 * Vue analytique globale du campus.
 * Query : academicYear?, semester?, campusId?
 */
router.get(
  '/campus/overview',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  getCampusOverview
);

/**
 * GET /api/results/transcript/:studentId
 * Relevé de notes complet d'un étudiant (calculé à la volée).
 * Query : academicYear?
 */
router.get(
  '/transcript/:studentId',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER', 'STUDENT']),
  getTranscript
);

/**
 * GET /api/results/final-transcripts/:studentId
 * Bulletin définitif stocké (généré lors de lockSemester).
 * Query : academicYear, semester
 */
router.get(
  '/final-transcripts/:studentId',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER', 'STUDENT']),
  getFinalTranscript
);

/**
 * POST /api/results/final-transcripts/:id/validate
 * Valide un bulletin définitif DRAFT → VALIDATED (Campus Manager).
 * Body : { decision?, generalAppreciation? }
 */
router.post(
  '/final-transcripts/:id/validate',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  validateTranscript
);

/**
 * GET /api/results/statistics/:classId
 * Distribution statistique d'une évaluation (avant soumission).
 * Query : subjectId, evaluationTitle, academicYear, semester
 */
router.get(
  '/statistics/:classId',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  getClassStatistics
);

/**
 * GET /api/results/retake-list/:classId
 * Liste des étudiants éligibles au rattrapage.
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
 * Liste paginée avec filtres.
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
 * Crée un résultat individuel (DRAFT).
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
 * Détail complet avec audit log et feedback pédagogique.
 */
router.get(
  '/:id',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER', 'STUDENT']),
  getResultById
);

/**
 * PUT /api/results/:id
 * Met à jour un résultat DRAFT ou SUBMITTED (avec droits appropriés).
 * Utilise result.canModify(role, userId) [S3-1].
 */
router.put(
  '/:id',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  updateResult
);

/**
 * DELETE /api/results/:id
 * Soft-delete (DRAFT uniquement pour non-admin).
 */
router.delete(
  '/:id',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  deleteResult
);

// ─── WORKFLOW INDIVIDUEL ──────────────────────────────────────────────────────

/**
 * POST /api/results/:id/submit
 * Soumet un résultat DRAFT → SUBMITTED.
 */
router.post(
  '/:id/submit',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  submitResult
);

/**
 * PATCH /api/results/:id/publish
 * Publie un résultat SUBMITTED → PUBLISHED.
 * Déclenche calcul du risque de décrochage.
 * [S3-2] Transaction pour les RETAKE.
 */
router.patch(
  '/:id/publish',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  publishResult
);

/**
 * PATCH /api/results/:id/archive
 * Archive un résultat PUBLISHED → ARCHIVED.
 */
router.patch(
  '/:id/archive',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  archiveResult
);

module.exports = router;