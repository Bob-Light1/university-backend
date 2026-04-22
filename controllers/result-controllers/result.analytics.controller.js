'use strict';

/**
 * @file result.analytics.controller.js
 * @description Analyses, rapports et consultation des résultats académiques.
 *
 *  Endpoints gérés :
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

const { Result, RESULT_STATUS, SEMESTER }  = require('../../models/result.model');
const { GradingScale, GRADING_SYSTEM }     = require('../../models/gradinScale.model');
const { FinalTranscript, TRANSCRIPT_STATUS } = require('../../models/finalTranscript.model');
const Student = require('../../models/student-models/student.model');

const {
  asyncHandler,
  sendSuccess,
  sendError,
  sendCreated,
  sendNotFound,
  sendForbidden,
} = require('../../utils/responseHelpers');

const { isValidObjectId } = require('../../utils/validationHelpers');

const {
  isGlobalRole,
  isManagerRole,
  getCampusFilter,
  resolveCampusId,
} = require('./result.helper');

// ─── TRANSCRIPT (calculé à la volée) ─────────────────────────────────────────

/**
 * GET /api/results/transcript/:studentId
 * Relevé de notes complet d'un étudiant, calculé à la volée.
 * Pour les bulletins officiels post-clôture, utiliser getFinalTranscript.
 *
 * Query : academicYear? (filtre par année)
 */
const getTranscript = asyncHandler(async (req, res) => {
  const { studentId } = req.params;
  const { academicYear } = req.query;

  if (!isValidObjectId(studentId)) return sendError(res, 400, 'Invalid student ID.');

  // Un STUDENT ne peut voir que son propre relevé
  if (req.user.role === 'STUDENT' && studentId !== req.user.id)
    return sendForbidden(res, 'Access denied.');

  const student = await Student.findById(studentId)
    .select('firstName lastName matricule email schoolCampus studentClass')
    .lean();
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

  // Agrégation : groupe par (academicYear, semester, subject)
  const pipeline = [
    { $match: matchFilter },
    {
      $group: {
        _id: { academicYear: '$academicYear', semester: '$semester', subject: '$subject' },
        evaluations: {
          $push: {
            evaluationType:  '$evaluationType',
            evaluationTitle: '$evaluationTitle',
            examPeriod:      '$examPeriod',
            score:           '$score',
            maxScore:        '$maxScore',
            normalizedScore: '$normalizedScore',
            coefficient:     '$coefficient',
            gradeBand:       '$gradeBand',
            teacherRemarks:  '$teacherRemarks',
            strengths:       '$strengths',
            improvements:    '$improvements',
          },
        },
        subjectAvg:   { $avg: { $multiply: [{ $divide: ['$score', '$maxScore'] }, 20] } },
        subjectCoeff: { $first: '$coefficient' },
      },
    },
    {
      $lookup: {
        from: 'subjects', localField: '_id.subject', foreignField: '_id', as: 'subjectDoc',
      },
    },
    { $unwind: { path: '$subjectDoc', preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id:      { academicYear: '$_id.academicYear', semester: '$_id.semester' },
        subjects: {
          $push: {
            subjectId:   '$_id.subject',
            subjectName: '$subjectDoc.subject_name',
            subjectCode: '$subjectDoc.subject_code',
            coefficient: { $ifNull: ['$subjectDoc.coefficient', '$subjectCoeff'] },
            average:     { $round: ['$subjectAvg', 2] },
            evaluations: '$evaluations',
          },
        },
      },
    },
    { $sort: { '_id.academicYear': -1, '_id.semester': 1 } },
  ];

  const semesters = await Result.aggregate(pipeline);

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

// ─── STATISTIQUES DE CLASSE ───────────────────────────────────────────────────

/**
 * GET /api/results/statistics/:classId
 * Distribution statistique d'une évaluation (moyenne, écart-type, histogramme).
 * Utilisé par l'enseignant pour visualiser sa classe avant soumission.
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

  const stats = await Result.getClassDistribution(
    classId, subjectId, evaluationTitle, academicYear, semester
  );
  if (!stats) return sendError(res, 404, 'No results found for this evaluation.');

  return sendSuccess(res, 200, 'Class statistics fetched.', stats);
});

// ─── LISTE DE RATTRAPAGE ──────────────────────────────────────────────────────

/**
 * GET /api/results/retake-list/:classId
 * Liste des étudiants éligibles au rattrapage, groupés par étudiant.
 *
 * Query : subjectId? (filtre par matière), academicYear, semester
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

  const retakes = await Result.find(filter)
    .populate('student', 'firstName lastName matricule email')
    .populate('subject', 'subject_name subject_code coefficient')
    .select('student subject score maxScore normalizedScore gradeBand evaluationTitle evaluationType')
    .sort({ normalizedScore: 1 })
    .lean();

  // Grouper par étudiant
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
 * Vue analytique globale : taux de réussite, distribution par statut,
 * étudiants à risque, éligibles au rattrapage.
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

  const [facets] = await Result.aggregate([
    { $match: matchFilter },
    {
      $facet: {
        byStatus: [
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ],
        byEvalType: [
          { $group: { _id: '$evaluationType', count: { $sum: 1 } } },
        ],
        byExamPeriod: [
          {
            $match: { examPeriod: { $ne: null } },
          },
          { $group: { _id: '$examPeriod', count: { $sum: 1 } } },
        ],
        generalStats: [
          {
            $match: {
              status:    { $in: [RESULT_STATUS.PUBLISHED, RESULT_STATUS.ARCHIVED] },
              isDeleted: false,
            },
          },
          {
            $group: {
              _id:            null,
              avgNormalized:  { $avg: '$normalizedScore' },
              passingCount:   { $sum: { $cond: [{ $gte: ['$normalizedScore', 10] }, 1, 0] } },
              totalPublished: { $sum: 1 },
              retakeEligible: { $sum: { $cond: ['$isRetakeEligible', 1, 0] } },
              atRisk:         { $sum: { $cond: [{ $gte: ['$dropoutRiskScore', 60] }, 1, 0] } },
              absentStudents: { $sum: { $cond: [{ $eq: ['$examAttendance', 'absent'] }, 1, 0] } },
            },
          },
          {
            $project: {
              avgNormalized:  { $round: ['$avgNormalized', 2] },
              passingRate: {
                $round: [
                  { $multiply: [{ $divide: ['$passingCount', '$totalPublished'] }, 100] },
                  1,
                ],
              },
              totalPublished: 1, retakeEligible: 1, atRisk: 1, absentStudents: 1,
            },
          },
        ],
      },
    },
  ]);

  const overview = {
    byStatus:     Object.fromEntries((facets.byStatus    || []).map((s) => [s._id, s.count])),
    byEvalType:   Object.fromEntries((facets.byEvalType  || []).map((s) => [s._id, s.count])),
    byExamPeriod: Object.fromEntries((facets.byExamPeriod|| []).map((s) => [s._id, s.count])),
    ...(facets.generalStats?.[0] || {}),
  };
  delete overview._id;

  return sendSuccess(res, 200, 'Campus overview fetched.', overview);
});

// ─── VÉRIFICATION QR CODE (PUBLIC) ───────────────────────────────────────────

/**
 * GET /api/results/verify/:token
 * Endpoint PUBLIC (sans authentification).
 * Valide l'authenticité d'un bulletin via le token QR Code.
 * Ne retourne que les informations non-sensibles.
 */
const verifyResult = asyncHandler(async (req, res) => {
  const { token } = req.params;
  if (!token) return sendError(res, 400, 'Verification token is required.');

  const result = await Result.findOne({ verificationToken: token, isDeleted: false })
    .populate('student', 'firstName lastName matricule')
    .populate('subject', 'subject_name subject_code')
    .populate('class',   'className')
    .select('student subject class academicYear semester evaluationType evaluationTitle ' +
            'normalizedScore gradeBand publishedAt status examPeriod')
    .lean();

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
 * Récupère le bulletin définitif stocké (généré lors de lockSemester).
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

  const transcript = await FinalTranscript.findOne({ student: studentId, academicYear, semester })
    .populate('student', 'firstName lastName matricule email')
    .populate('class',   'className')
    .lean();

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

  const transcript = await FinalTranscript.findById(id);
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

  // Génération du token QR si absent
  if (!transcript.verificationToken) {
    const { randomUUID } = require('crypto');
    transcript.verificationToken = randomUUID();
  }

  await transcript.save();
  return sendSuccess(res, 200, 'Transcript validated.', transcript);
});

/**
 * POST /api/results/final-transcripts/:id/sign
 * Signature numérique du bulletin par le parent.
 * Endpoint accessible sans authentification enseignant/manager
 * (le parent s'identifie avec signedBy + OTP optionnel).
 *
 * Body : { signedBy (email ou ID parent), method? ('click'|'otp'|'biometric') }
 */
const signTranscript = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { signedBy, method } = req.body;

  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid transcript ID.');
  if (!signedBy) return sendError(res, 400, 'signedBy is required.');

  const transcript = await FinalTranscript.findById(id);
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

// ─── BARÈMES DE NOTATION ──────────────────────────────────────────────────────

/**
 * GET /api/results/grading-scales
 * Liste les barèmes actifs du campus courant.
 */
const listGradingScales = asyncHandler(async (req, res) => {
  const campusFilter = getCampusFilter(req, res);
  if (!campusFilter) return; // 403 already sent

  const scales = await GradingScale.find({ isActive: true, ...campusFilter })
    .sort({ isDefault: -1, name: 1 })
    .lean();

  return sendSuccess(res, 200, 'Grading scales fetched.', scales);
});

/**
 * POST /api/results/grading-scales
 * Crée un nouveau barème de notation pour le campus.
 * [S1-1] La validation des bands (overlap, tri) est gérée en pre-save.
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
    const scale = await GradingScale.create({
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
    // Erreur pre-save (overlap, bornes invalides) — retournée comme 400
    if (err.message && !err.code) return sendError(res, 400, err.message);
    throw err;
  }
});

/**
 * PATCH /api/results/grading-scales/:id
 * Met à jour un barème existant.
 * [S1-1] La validation des bands est gérée en pre-save.
 */
const updateGradingScale = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid grading scale ID.');

  if (!isManagerRole(req.user.role))
    return sendForbidden(res, 'Only managers can update grading scales.');

  const scale = await GradingScale.findById(id);
  if (!scale || !scale.isActive) return sendNotFound(res, 'GradingScale');

  if (!isGlobalRole(req.user.role) &&
      scale.schoolCampus.toString() !== req.user.campusId?.toString())
    return sendForbidden(res, 'Access denied.');

  const allowed = ['name', 'description', 'passMark', 'bands', 'isDefault', 'isActive'];
  allowed.forEach((field) => { if (req.body[field] !== undefined) scale[field] = req.body[field]; });
  scale.updatedBy = req.user.id;

  try {
    await scale.save();
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
  // Vérification publique
  verifyResult,
  // Barèmes
  listGradingScales,
  createGradingScale,
  updateGradingScale,
};