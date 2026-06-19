'use strict';

/**
 * @file result.analytics.controller.js
 * @description Analyses, reports and consultation of academic results.
 *
 *  Handled endpoints :
 *  ─────────────────────────────────────────────────────────────────
 *  GET  /api/results/transcript/:studentId   → getTranscript
 *  GET  /api/results/statistics/:classId     → getClassStatistics
 *  GET  /api/results/retake-list/:classId    → getRetakeList
 *  GET  /api/results/campus/overview         → getCampusOverview
 *  GET  /api/results/verify/:token           → verifyResult (public)
 *
 *  GET    /api/results/grading-scales        → listGradingScales
 *  POST   /api/results/grading-scales        → createGradingScale
 *  PATCH  /api/results/grading-scales/:id    → updateGradingScale
 *
 *  GET  /api/results/final-transcripts/:studentId   → getFinalTranscript
 *  POST /api/results/final-transcripts/:id/validate → validateTranscript
 *  POST /api/results/final-transcripts/:id/sign     → signTranscript (parent)
 */

const mongoose = require('mongoose');

const { RESULT_STATUS, SEMESTER }  = require('../models/result.model');
const { GRADING_SYSTEM }           = require('../models/grading-scale.model');
const { TRANSCRIPT_STATUS }        = require('../models/final-transcript.model');
const resultRepo = require('../result.repository');
// Lazy require : student.dashboard consumes the result facade (result ↔ student cycle)
const getStudentProfileRef = (...args) =>
  require('../../student').service.getStudentProfileRef(...args);

const {
  asyncHandler,
  sendSuccess,
  sendError,
  sendCreated,
  sendNotFound,
  sendForbidden,
} = require('../../../shared/utils/response-helpers');

const { isValidObjectId } = require('../../../shared/utils/validation-helpers');

const {
  isGlobalRole,
  isManagerRole,
  getCampusFilter,
  resolveCampusId,
} = require('./result.helper');

// ─── TRANSCRIPT (computed on the fly) ────────────────────────────────────────

/**
 * GET /api/results/transcript/:studentId
 * Complete transcript of a student, computed on the fly.
 * For official post-lock transcripts, use getFinalTranscript.
 *
 * Query : academicYear? (filter by year)
 */
const getTranscript = asyncHandler(async (req, res) => {
  const { studentId } = req.params;
  const { academicYear } = req.query;

  if (!isValidObjectId(studentId)) return sendError(res, 400, 'Invalid student ID.');

  // A STUDENT can only see their own transcript
  if (req.user.role === 'STUDENT' && studentId !== req.user.id)
    return sendForbidden(res, 'Access denied.');

  const student = await getStudentProfileRef(studentId);
  if (!student) return sendNotFound(res, 'Student');

  if (!isGlobalRole(req.user.role) &&
      student.schoolCampus.toString() !== req.user.campusId?.toString())
    return sendForbidden(res, 'Access denied.');

  const matchFilter = {
    student:   new mongoose.Types.ObjectId(studentId),
    status:    { $in: [RESULT_STATUS.PUBLISHED, RESULT_STATUS.ARCHIVED] },
    isDeleted: false,
    retakeOf:  null,
    examAttendance: { $ne: 'excused' },
  };
  if (academicYear) matchFilter.academicYear = academicYear;

  // Aggregation (group by year/semester/subject) — pipeline carried by the repo.
  const semesters = await resultRepo.aggregateStudentTranscript(matchFilter);

  const enriched = semesters.map((sem) => {
    let wSum = 0, wTotal = 0;
    for (const s of sem.subjects) {
      wSum   += (s.average || 0) * (s.coefficient || 1);
      wTotal += s.coefficient || 1;
    }
    return {
      academicYear:   sem._id.academicYear,
      semester:       sem._id.semester,
      generalAverage: wTotal > 0 ? parseFloat((wSum / wTotal).toFixed(2)) : null,
      subjects:       sem.subjects,
    };
  });

  return sendSuccess(res, 200, 'Transcript fetched.', {
    student: {
      _id:       student._id,
      firstName: student.firstName,
      lastName:  student.lastName,
      matricule: student.matricule,
      email:     student.email,
    },
    semesters: enriched,
    verificationUrl: `${process.env.APP_URL || ''}/api/results/verify`,
  });
});

// ─── CLASS STATISTICS ─────────────────────────────────────────────────────────

/**
 * GET /api/results/statistics/:classId
 * Statistical distribution of an evaluation (mean, standard deviation, histogram).
 * Used by the teacher to visualize their class before submission.
 *
 * Query : subjectId, evaluationTitle, academicYear, semester
 */
const getClassStatistics = asyncHandler(async (req, res) => {
  const { classId } = req.params;
  const { subjectId, evaluationTitle, academicYear, semester } = req.query;

  if (!isValidObjectId(classId))   return sendError(res, 400, 'Invalid classId.');
  if (!isValidObjectId(subjectId)) return sendError(res, 400, 'subjectId query param is required.');
  if (!evaluationTitle)            return sendError(res, 400, 'evaluationTitle query param is required.');
  if (!academicYear || !semester)  return sendError(res, 400, 'academicYear and semester are required.');

  const stats = await resultRepo.getClassDistribution(
    classId, subjectId, evaluationTitle, academicYear, semester
  );
  if (!stats) return sendError(res, 404, 'No results found for this evaluation.');

  return sendSuccess(res, 200, 'Class statistics fetched.', stats);
});

// ─── RETAKE LIST ──────────────────────────────────────────────────────────────

/**
 * GET /api/results/retake-list/:classId
 * List of students eligible for retake, grouped by student.
 *
 * Query : subjectId? (filter by subject), academicYear, semester
 */
const getRetakeList = asyncHandler(async (req, res) => {
  const { classId } = req.params;
  const { subjectId, academicYear, semester } = req.query;

  if (!isValidObjectId(classId))  return sendError(res, 400, 'Invalid classId.');
  if (!academicYear || !semester) return sendError(res, 400, 'academicYear and semester are required.');

  if (!isManagerRole(req.user.role) && req.user.role !== 'TEACHER')
    return sendForbidden(res, 'Access denied.');

  const campusFilter = getCampusFilter(req, res);
  if (!campusFilter) return; // 403 already sent

  const filter = {
    class:            classId,
    academicYear,
    semester,
    isRetakeEligible: true,
    status:           { $in: [RESULT_STATUS.PUBLISHED, RESULT_STATUS.ARCHIVED] },
    isDeleted:        false,
    retakeOf:         null,
    ...campusFilter,
  };
  if (subjectId && isValidObjectId(subjectId)) filter.subject = subjectId;

  const retakes = await resultRepo.listRetakeResults(filter);

  // Group by student
  const byStudent = {};
  for (const r of retakes) {
    const sid = r.student._id.toString();
    if (!byStudent[sid]) byStudent[sid] = { student: r.student, failedSubjects: [] };
    byStudent[sid].failedSubjects.push({
      subject:         r.subject,
      score:           r.score,
      maxScore:        r.maxScore,
      normalizedScore: r.normalizedScore,
      gradeBand:       r.gradeBand,
      evaluationTitle: r.evaluationTitle,
      evaluationType:  r.evaluationType,
      scoreColor:      r.normalizedScore < 7 ? '#ef4444' : '#f97316',
    });
  }

  return sendSuccess(res, 200, 'Retake list fetched.', {
    total:    Object.keys(byStudent).length,
    students: Object.values(byStudent),
  });
});

// ─── CAMPUS OVERVIEW ─────────────────────────────────────────────────────────

/**
 * GET /api/results/campus/overview
 * Global analytics view : pass rate, distribution by status,
 * at-risk students, retake-eligible.
 *
 * Query : academicYear?, semester?, campusId? (ADMIN/DIRECTOR)
 */
const getCampusOverview = asyncHandler(async (req, res) => {
  const { academicYear, semester } = req.query;

  if (!isManagerRole(req.user.role)) return sendForbidden(res, 'Access denied.');

  const campusFilter = getCampusFilter(req, res);
  if (!campusFilter) return; // 403 already sent — campus not resolvable

  const matchFilter  = { isDeleted: false, ...campusFilter };
  if (academicYear) matchFilter.academicYear = academicYear;
  if (semester && Object.values(SEMESTER).includes(semester)) matchFilter.semester = semester;

  const [facets] = await resultRepo.aggregateCampusOverview(matchFilter);

  const overview = {
    byStatus:     Object.fromEntries((facets.byStatus    || []).map((s) => [s._id, s.count])),
    byEvalType:   Object.fromEntries((facets.byEvalType  || []).map((s) => [s._id, s.count])),
    byExamPeriod: Object.fromEntries((facets.byExamPeriod|| []).map((s) => [s._id, s.count])),
    ...(facets.generalStats?.[0] || {}),
  };
  delete overview._id;

  return sendSuccess(res, 200, 'Campus overview fetched.', overview);
});

// ─── QR CODE VERIFICATION (PUBLIC) ───────────────────────────────────────────

/**
 * GET /api/results/verify/:token
 * PUBLIC endpoint (without authentication).
 * Validates the authenticity of a transcript via the QR Code token.
 * Only returns non-sensitive information.
 */
const verifyResult = asyncHandler(async (req, res) => {
  const { token } = req.params;
  if (!token) return sendError(res, 400, 'Verification token is required.');

  const result = await resultRepo.findResultByVerificationToken(token);

  if (!result || result.status === RESULT_STATUS.DRAFT)
    return sendError(res, 404, 'Invalid or expired verification token.');

  return sendSuccess(res, 200, 'Result verified. This document is authentic.', {
    isAuthentic:     true,
    student:         result.student,
    subject:         result.subject,
    class:           result.class,
    academicYear:    result.academicYear,
    semester:        result.semester,
    evaluationType:  result.evaluationType,
    evaluationTitle: result.evaluationTitle,
    examPeriod:      result.examPeriod,
    scoreOn20:       result.normalizedScore,
    gradeBand:       result.gradeBand,
    publishedAt:     result.publishedAt,
  });
});

// ─── FINAL TRANSCRIPTS ────────────────────────────────────────────────────────

/**
 * GET /api/results/final-transcripts/:studentId
 * Retrieves the stored final transcript (generated during lockSemester).
 *
 * Query : academicYear, semester
 */
const getFinalTranscript = asyncHandler(async (req, res) => {
  const { studentId } = req.params;
  const { academicYear, semester } = req.query;

  if (!isValidObjectId(studentId)) return sendError(res, 400, 'Invalid student ID.');
  if (!academicYear || !semester)  return sendError(res, 400, 'academicYear and semester are required.');

  if (req.user.role === 'STUDENT' && studentId !== req.user.id)
    return sendForbidden(res, 'Access denied.');

  const transcript = await resultRepo.findTranscriptForStudentPopulated({ studentId, academicYear, semester });

  if (!transcript) return sendNotFound(res, 'FinalTranscript');

  if (!isGlobalRole(req.user.role) &&
      transcript.schoolCampus.toString() !== req.user.campusId?.toString())
    return sendForbidden(res, 'Access denied.');

  return sendSuccess(res, 200, 'Final transcript fetched.', transcript);
});

/**
 * POST /api/results/final-transcripts/:id/validate
 * Valide un bulletin définitif DRAFT → VALIDATED.
 * CAMPUS_MANAGER uniquement.
 */
const validateTranscript = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid transcript ID.');
  if (!isManagerRole(req.user.role)) return sendForbidden(res, 'Only managers can validate transcripts.');

  const transcript = await resultRepo.findTranscriptForWrite(id);
  if (!transcript) return sendNotFound(res, 'FinalTranscript');

  if (!isGlobalRole(req.user.role) &&
      transcript.schoolCampus.toString() !== req.user.campusId?.toString())
    return sendForbidden(res, 'Access denied.');

  if (transcript.status !== TRANSCRIPT_STATUS.DRAFT)
    return sendError(res, 400, `Transcript is already ${transcript.status}.`);

  const { decision, generalAppreciation } = req.body;
  transcript.status             = TRANSCRIPT_STATUS.VALIDATED;
  transcript.validatedBy        = req.user.id;
  if (decision)             transcript.decision             = decision;
  if (generalAppreciation)  transcript.generalAppreciation  = generalAppreciation;

  // QR token generation if absent
  if (!transcript.verificationToken) {
    const { randomUUID } = require('crypto');
    transcript.verificationToken = randomUUID();
  }

  await resultRepo.saveTranscriptDoc(transcript);
  return sendSuccess(res, 200, 'Transcript validated.', transcript);
});

/**
 * POST /api/results/final-transcripts/:id/sign
 * Digital signature of the transcript by the parent.
 * Endpoint accessible without teacher/manager authentication
 * (the parent identifies with signedBy + optional OTP).
 *
 * Body : { signedBy (email or parent ID), method? ('click'|'otp'|'biometric') }
 */
const signTranscript = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { signedBy, method } = req.body;

  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid transcript ID.');
  if (!signedBy) return sendError(res, 400, 'signedBy is required.');

  const transcript = await resultRepo.findTranscriptForWrite(id);
  if (!transcript) return sendNotFound(res, 'FinalTranscript');

  try {
    await transcript.signByParent(signedBy, req.ip, method || 'click');
    return sendSuccess(res, 200, 'Transcript signed by parent.', {
      signedAt:  transcript.parentSignature.signedAt,
      signedBy:  transcript.parentSignature.signedBy,
    });
  } catch (err) {
    return sendError(res, 400, err.message);
  }
});

// ─── GRADING SCALES ───────────────────────────────────────────────────────────

/**
 * GET /api/results/grading-scales
 * Lists the active grading scales of the current campus.
 */
const listGradingScales = asyncHandler(async (req, res) => {
  const campusFilter = getCampusFilter(req, res);
  if (!campusFilter) return; // 403 already sent

  const scales = await resultRepo.listActiveGradingScales(campusFilter);

  return sendSuccess(res, 200, 'Grading scales fetched.', scales);
});

/**
 * POST /api/results/grading-scales
 * Creates a new grading scale for the campus.
 * [S1-1] The bands validation (overlap, sort) is handled in pre-save.
 *
 * Body : { name, description?, system, maxScore, passMark, bands[], isDefault? }
 */
const createGradingScale = asyncHandler(async (req, res) => {
  if (!isManagerRole(req.user.role))
    return sendForbidden(res, 'Only managers can create grading scales.');

  const { name, description, system, maxScore, passMark, bands, isDefault } = req.body;

  if (!name || !system || maxScore == null || passMark == null)
    return sendError(res, 400, 'name, system, maxScore and passMark are required.');

  if (!Object.values(GRADING_SYSTEM).includes(system))
    return sendError(res, 400, `Invalid system. Must be: ${Object.values(GRADING_SYSTEM).join(', ')}.`);

  if (Number(passMark) > Number(maxScore))
    return sendError(res, 400, 'passMark cannot exceed maxScore.');

  const resolvedCampus = resolveCampusId(req, req.body.schoolCampus);
  if (!resolvedCampus) return sendError(res, 400, 'schoolCampus is required.');

  try {
    const scale = await resultRepo.createGradingScale({
      schoolCampus: resolvedCampus,
      name, description, system,
      maxScore:  Number(maxScore),
      passMark:  Number(passMark),
      bands:     bands || [],
      isDefault: isDefault === true,
      createdBy: req.user.id,
    });
    return sendCreated(res, 'Grading scale created.', scale);
  } catch (err) {
    // Pre-save error (overlap, invalid bounds) — returned as 400
    if (err.message && !err.code) return sendError(res, 400, err.message);
    throw err;
  }
});

/**
 * PATCH /api/results/grading-scales/:id
 * Updates an existing grading scale.
 * [S1-1] The bands validation is handled in pre-save.
 */
const updateGradingScale = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid grading scale ID.');

  if (!isManagerRole(req.user.role))
    return sendForbidden(res, 'Only managers can update grading scales.');

  const scale = await resultRepo.findGradingScaleForWrite(id);
  if (!scale || !scale.isActive) return sendNotFound(res, 'GradingScale');

  if (!isGlobalRole(req.user.role) &&
      scale.schoolCampus.toString() !== req.user.campusId?.toString())
    return sendForbidden(res, 'Access denied.');

  const allowed = ['name', 'description', 'passMark', 'bands', 'isDefault', 'isActive'];
  allowed.forEach((field) => { if (req.body[field] !== undefined) scale[field] = req.body[field]; });
  scale.updatedBy = req.user.id;

  try {
    await resultRepo.saveGradingScaleDoc(scale);
    return sendSuccess(res, 200, 'Grading scale updated.', scale);
  } catch (err) {
    if (err.message && !err.code) return sendError(res, 400, err.message);
    throw err;
  }
});

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  // Transcript
  getTranscript,
  getFinalTranscript,
  validateTranscript,
  signTranscript,
  // Stats
  getClassStatistics,
  getRetakeList,
  getCampusOverview,
  // Public verification
  verifyResult,
  // Grading scales
  listGradingScales,
  createGradingScale,
  updateGradingScale,
};