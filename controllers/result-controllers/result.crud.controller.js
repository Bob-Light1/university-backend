'use strict';

/**
 * @file result.crud.controller.js
 * @description Opérations CRUD sur les résultats académiques.
 *
 *  Endpoints gérés :
 *  ─────────────────────────────────────────────────────────────────
 *  POST   /api/results                → createResult
 *  POST   /api/results/bulk           → bulkCreateResults
 *  POST   /api/results/upload-csv     → uploadResultsCSV
 *  GET    /api/results                → getResults
 *  GET    /api/results/:id            → getResultById
 *  PUT    /api/results/:id            → updateResult
 *  DELETE /api/results/:id            → deleteResult
 */

const mongoose = require('mongoose');
const { parse: csvParse } = require('csv-parse/sync');

const { Result, RESULT_STATUS, EVALUATION_TYPE, SEMESTER } = require('../../models/result.model');
const Class   = require('../../models/class.model');
const Student = require('../../models/student.model');

const {
  asyncHandler,
  sendSuccess,
  sendError,
  sendCreated,
  sendPaginated,
  sendNotFound,
  sendForbidden,
  handleDuplicateKeyError,
} = require('../../utils/responseHelpers');

const {
  isValidObjectId,
  validateStudentBelongsToCampus,
} = require('../../utils/validationHelpers');

const {
  isGlobalRole,
  isManagerRole,
  getCampusFilter,
  resolveCampusId,
  validateResultContext,
  validateResultIds,
  parsePositiveInt,
  RESULT_POPULATE,
} = require('./result.helper');

// ─── CREATE (individuel) ──────────────────────────────────────────────────────

/**
 * POST /api/results
 * Crée un résultat individuel au statut DRAFT.
 *
 * Body : { student, class, subject, teacher, score, maxScore, coefficient?,
 *           evaluationType, evaluationTitle, academicYear, semester,
 *           examDate?, examPeriod?, examAttendance?,
 *           teacherRemarks?, strengths?, improvements?,
 *           gradingScale?, schoolCampus? }
 */
const createResult = asyncHandler(async (req, res) => {
  const {
    student, class: classId, subject, teacher,
    score, maxScore, coefficient,
    evaluationType, evaluationTitle, academicYear, semester,
    examDate, examPeriod, examAttendance,
    teacherRemarks, strengths, improvements, specialCircumstances,
    gradingScale, schoolCampus: campusFromBody,
  } = req.body;

  const resolvedCampus = resolveCampusId(req, campusFromBody);
  if (!resolvedCampus) return sendError(res, 400, 'schoolCampus is required.');

  // Validation des IDs
  const idError = validateResultIds({ student, classId, subject, teacher });
  if (idError) return sendError(res, 400, idError);

  // Validation des champs contextuels
  const ctxError = validateResultContext({ evaluationType, semester, academicYear, score, maxScore });
  if (ctxError) return sendError(res, 400, ctxError);

  if (!evaluationTitle?.trim()) return sendError(res, 400, 'evaluationTitle is required.');

  // Campus isolation : l'étudiant appartient-il au campus ?
  if (!isGlobalRole(req.user.role)) {
    const belongs = await validateStudentBelongsToCampus(student, resolvedCampus);
    if (!belongs) return sendForbidden(res, 'Student does not belong to your campus.');
  }

  try {
    const result = await Result.create({
      student, class: classId, subject, teacher,
      score:           Number(score),
      maxScore:        Number(maxScore),
      coefficient:     coefficient != null ? Number(coefficient) : 1,
      evaluationType, evaluationTitle: evaluationTitle.trim(),
      academicYear, semester,
      examDate:        examDate || null,
      examPeriod:      examPeriod || null,
      examAttendance:  examAttendance || 'present',
      teacherRemarks:  teacherRemarks || null,
      strengths:       strengths || null,
      improvements:    improvements || null,
      specialCircumstances: specialCircumstances || null,
      gradingScale:    gradingScale || null,
      schoolCampus:    resolvedCampus,
      status:          RESULT_STATUS.DRAFT,
    });

    return sendCreated(res, 'Result created as DRAFT.', result);
  } catch (err) {
    if (err.code === 11000) return handleDuplicateKeyError(res, err);
    throw err;
  }
});

// ─── BULK CREATE ──────────────────────────────────────────────────────────────

/**
 * POST /api/results/bulk
 * Saisie massive pour une classe entière.
 *
 * Body : {
 *   classId, subjectId, teacherId,
 *   evaluationType, evaluationTitle, academicYear, semester,
 *   maxScore, examDate?, examPeriod?, gradingScale?,
 *   results: [{ studentId, score, coefficient?, teacherRemarks?,
 *               examAttendance?, strengths?, improvements? }]
 * }
 *
 * Retourne 207 Multi-Status avec le détail des insertions et erreurs.
 */
const bulkCreateResults = asyncHandler(async (req, res) => {
  const {
    classId, subjectId, teacherId,
    evaluationType, evaluationTitle, academicYear, semester,
    maxScore, examDate, examPeriod, gradingScale,
    results: entries = [],
    schoolCampus: campusFromBody,
  } = req.body;

  const resolvedCampus = resolveCampusId(req, campusFromBody);
  if (!resolvedCampus) return sendError(res, 400, 'schoolCampus is required.');

  if (!isValidObjectId(classId))   return sendError(res, 400, 'Invalid classId.');
  if (!isValidObjectId(subjectId)) return sendError(res, 400, 'Invalid subjectId.');
  if (!isValidObjectId(teacherId)) return sendError(res, 400, 'Invalid teacherId.');
  if (!Array.isArray(entries) || !entries.length)
    return sendError(res, 400, 'results[] must be a non-empty array.');

  const ctxError = validateResultContext({
    evaluationType, semester, academicYear,
    score: 0, maxScore: Number(maxScore) || 1,  // score fictif pour valider le contexte
  });
  if (ctxError && !ctxError.includes('Score')) return sendError(res, 400, ctxError);
  if (!maxScore || Number(maxScore) < 1) return sendError(res, 400, 'maxScore must be at least 1.');
  if (!evaluationTitle?.trim()) return sendError(res, 400, 'evaluationTitle is required.');

  // Verify the class belongs to the campus
  const classDoc = await Class.findById(classId).select('schoolCampus').lean();
  if (!classDoc) return sendNotFound(res, 'Class');
  if (!isGlobalRole(req.user.role) && classDoc.schoolCampus.toString() !== resolvedCampus.toString())
    return sendForbidden(res, 'Class does not belong to your campus.');

  /*
   * Build enrollment set from the Student collection directly.
   *
   * Rationale: classDoc.students[] (the array stored on the Class document)
   * may be empty or out-of-sync if students were created without an explicit
   * push onto that array (e.g. via the generic student controller which only
   * sets studentClass on the Student document). The authoritative source of
   * enrollment is Student.studentClass, not Class.students[].
   *
   * Campus isolation is enforced by filtering on schoolCampus as well.
   */
  const enrolledDocs = await Student.find(
    {
      studentClass: new mongoose.Types.ObjectId(classId),
      schoolCampus: new mongoose.Types.ObjectId(resolvedCampus),
    },
    { _id: 1 }
  ).lean();
  const enrolledIds = new Set(enrolledDocs.map((s) => s._id.toString()));
  const errors      = [];
  const toInsert    = [];

  for (let i = 0; i < entries.length; i++) {
    const { studentId, score, coefficient: ec, teacherRemarks, examAttendance, strengths, improvements } = entries[i];

    if (!isValidObjectId(studentId)) {
      errors.push({ index: i, studentId, error: 'Invalid studentId.' }); continue;
    }
    if (!enrolledIds.has(studentId.toString())) {
      errors.push({ index: i, studentId, error: 'Student not enrolled in this class.' }); continue;
    }
    const s = Number(score);
    if (!Number.isFinite(s) || s < 0 || s > Number(maxScore)) {
      errors.push({ index: i, studentId, error: `Score must be 0–${maxScore}.` }); continue;
    }

    toInsert.push({
      student:         studentId,
      class:           classId,
      subject:         subjectId,
      teacher:         teacherId,
      score:           s,
      maxScore:        Number(maxScore),
      coefficient:     ec != null ? Number(ec) : 1,
      evaluationType,
      evaluationTitle: evaluationTitle.trim(),
      academicYear,
      semester,
      examDate:        examDate || null,
      examPeriod:      examPeriod || null,
      examAttendance:  examAttendance || 'present',
      teacherRemarks:  teacherRemarks || null,
      strengths:       strengths || null,
      improvements:    improvements || null,
      gradingScale:    gradingScale || null,
      schoolCampus:    resolvedCampus,
      status:          RESULT_STATUS.DRAFT,
    });
  }

  if (!toInsert.length) return sendError(res, 400, 'No valid entries to insert.', errors);

  let inserted = [], duplicates = [];
  try {
    inserted = await Result.insertMany(toInsert, { ordered: false });
  } catch (err) {
    if (err.code === 11000 || err.name === 'BulkWriteError') {
      inserted   = err.insertedDocs  || [];
      duplicates = (err.writeErrors  || []).map((e) => ({
        index:     e.index,
        studentId: toInsert[e.index]?.student,
        error:     'Duplicate result for this evaluation.',
      }));
    } else {
      throw err;
    }
  }

  return sendSuccess(res, 207, 'Bulk create completed.', {
    inserted:  inserted.length,
    skipped:   errors.length + duplicates.length,
    errors:    [...errors, ...duplicates],
  });
});

// ─── UPLOAD CSV ───────────────────────────────────────────────────────────────

/**
 * POST /api/results/upload-csv
 * Import massif via fichier CSV. Colonnes attendues :
 *   studentId, score, coefficient (opt), teacherRemarks (opt),
 *   examAttendance (opt), strengths (opt), improvements (opt)
 *
 * Les paramètres contextuels (classId, subjectId, etc.) sont fournis en form-data
 * comme pour /bulk.
 */
const uploadResultsCSV = asyncHandler(async (req, res) => {
  if (!req.file) return sendError(res, 400, 'No CSV file uploaded.');

  let rows;
  try {
    rows = csvParse(req.file.buffer.toString('utf-8'), {
      columns:          true,
      skip_empty_lines: true,
      trim:             true,
    });
  } catch (err) {
    return sendError(res, 400, `CSV parsing error: ${err.message}`);
  }

  if (!rows.length) return sendError(res, 400, 'CSV file is empty.');

  // Réutilisation de bulkCreateResults après normalisation des données CSV
  req.body.results = rows.map((row) => ({
    studentId:      row.studentId   || row.student_id,
    score:          Number(row.score),
    coefficient:    row.coefficient ? Number(row.coefficient) : undefined,
    teacherRemarks: row.teacherRemarks || row.teacher_remarks || null,
    examAttendance: row.examAttendance || row.exam_attendance || 'present',
    strengths:      row.strengths      || null,
    improvements:   row.improvements   || null,
  }));

  return bulkCreateResults(req, res);
});

// ─── READ ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/results
 * Liste paginée des résultats avec filtres multidimensionnels.
 *
 * Query : classId?, subjectId?, teacherId?, studentId?, status?,
 *         evaluationType?, academicYear?, semester?, examPeriod?,
 *         campusId? (ADMIN/DIRECTOR), page, limit
 */
const getResults = asyncHandler(async (req, res) => {
  const {
    classId, subjectId, teacherId, studentId,
    status, evaluationType, academicYear, semester, examPeriod,
    page = 1, limit = 50,
  } = req.query;

  const campusFilter = getCampusFilter(req, res);
  if (!campusFilter) return; // 403 already sent — campus not resolvable

  const filter = { isDeleted: false, ...campusFilter };

  if (classId      && isValidObjectId(classId))   filter.class   = classId;
  if (subjectId    && isValidObjectId(subjectId)) filter.subject = subjectId;
  if (teacherId    && isValidObjectId(teacherId)) filter.teacher = teacherId;
  if (studentId    && isValidObjectId(studentId)) filter.student = studentId;
  if (status       && Object.values(RESULT_STATUS).includes(status))       filter.status = status;
  if (evaluationType && Object.values(EVALUATION_TYPE).includes(evaluationType))
    filter.evaluationType = evaluationType;
  if (academicYear) filter.academicYear = academicYear;
  if (semester     && Object.values(SEMESTER).includes(semester))          filter.semester = semester;
  if (examPeriod)   filter.examPeriod = examPeriod;

  // Les STUDENTs ne voient que leurs notes publiées/archivées
  if (req.user.role === 'STUDENT') {
    filter.student = req.user.id;
    filter.status  = { $in: [RESULT_STATUS.PUBLISHED, RESULT_STATUS.ARCHIVED] };
  }

  const pageNum  = parsePositiveInt(page,  1);
  const limitNum = parsePositiveInt(limit, 50);

  let query = Result.find(filter).sort({ createdAt: -1 });
  for (const p of RESULT_POPULATE.LIST) query = query.populate(p);

  const [results, total] = await Promise.all([
    query.skip((pageNum - 1) * limitNum).limit(limitNum).lean(),
    Result.countDocuments(filter),
  ]);

  return sendPaginated(res, 200, 'Results fetched.', results, { total, page: pageNum, limit: limitNum });
});

/**
 * GET /api/results/:id
 * Détail complet d'un résultat, avec audit log et feedback pédagogique.
 */
const getResultById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid result ID.');

  let query = Result.findOne({ _id: id, isDeleted: false });
  for (const p of RESULT_POPULATE.DETAIL) query = query.populate(p);
  const result = await query.lean();

  if (!result) return sendNotFound(res, 'Result');

  // ── Layer 1: campus isolation — applies to ALL roles including STUDENT ──────
  // Must be checked BEFORE the STUDENT ownership check to prevent a logged-in
  // student from retrieving results that belong to a different campus by guessing
  // result IDs (the student ownership check below does NOT imply campus membership).
  if (!isGlobalRole(req.user.role)) {
    // Defensive: ensure campusId is present in the JWT for non-global roles.
    if (!req.user.campusId) {
      return sendForbidden(res, 'Campus information is missing from your session. Please log in again.');
    }
    // result.schoolCampus is a raw ObjectId at this point (not populated in findOne).
    if (result.schoolCampus.toString() !== req.user.campusId.toString()) {
      return sendForbidden(res, 'Access denied.');
    }
  }

  // ── Layer 2: STUDENT ownership + publication status ─────────────────────────
  if (req.user.role === 'STUDENT') {
    if (result.student._id.toString() !== req.user.id)
      return sendForbidden(res, 'Access denied.');
    if (![RESULT_STATUS.PUBLISHED, RESULT_STATUS.ARCHIVED].includes(result.status))
      return sendError(res, 404, 'Result not found or not yet published.');
  }

  return sendSuccess(res, 200, 'Result fetched.', result);
});

// ─── UPDATE ───────────────────────────────────────────────────────────────────

/**
 * PUT /api/results/:id
 * Met à jour un résultat DRAFT (ou SUBMITTED pour les managers).
 * Pour les PUBLISHED/ARCHIVED, utiliser PATCH /audit/:id (ADMIN/DIRECTOR).
 *
 * Body : champs partiels parmi les allowed fields.
 */
const updateResult = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid result ID.');

  const result = await Result.findOne({ _id: id, isDeleted: false });
  if (!result) return sendNotFound(res, 'Result');

  // Vérification des droits via canModify [S3-1]
  const { ok, reason } = result.canModify(req.user.role, req.user.id);
  if (!ok) return sendError(res, 403, reason);

  // Campus isolation
  if (!isGlobalRole(req.user.role) &&
      result.schoolCampus.toString() !== req.user.campusId?.toString())
    return sendForbidden(res, 'Access denied.');

  const allowed = [
    'score', 'maxScore', 'coefficient',
    'teacherRemarks', 'classManagerRemarks', 'strengths', 'improvements',
    'gradingScale', 'evaluationTitle',
    'examDate', 'examPeriod', 'examAttendance', 'specialCircumstances',
  ];
  // classManagerRemarks ne peut être modifié que par les managers
  if (req.body.classManagerRemarks !== undefined && !isManagerRole(req.user.role)) {
    return sendForbidden(res, 'Only managers can add class manager remarks.');
  }

  allowed.forEach((field) => {
    if (req.body[field] !== undefined) result[field] = req.body[field];
  });

  // Si le manager ajoute classManagerRemarks, on trace qui l'a fait
  if (req.body.classManagerRemarks !== undefined) {
    result.classManager = new mongoose.Types.ObjectId(req.user.id);
  }

  await result.save();
  return sendSuccess(res, 200, 'Result updated.', result);
});

// ─── DELETE (soft) ────────────────────────────────────────────────────────────

/**
 * DELETE /api/results/:id
 * Soft-delete. DRAFT uniquement pour TEACHER/CAMPUS_MANAGER.
 * ADMIN/DIRECTOR peuvent supprimer n'importe quel statut.
 */
const deleteResult = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid result ID.');

  const result = await Result.findOne({ _id: id, isDeleted: false });
  if (!result) return sendNotFound(res, 'Result');

  if (!isGlobalRole(req.user.role) &&
      result.schoolCampus.toString() !== req.user.campusId?.toString())
    return sendForbidden(res, 'Access denied.');

  if (result.status !== RESULT_STATUS.DRAFT && !isGlobalRole(req.user.role))
    return sendError(res, 400, 'Only DRAFT results can be deleted. Use ADMIN access for published results.');

  if (result.periodLocked && !isGlobalRole(req.user.role))
    return sendError(res, 403, 'This semester is locked.');

  result.isDeleted = true;
  result.deletedAt = new Date();
  result.deletedBy = req.user.id;
  await result.save();

  return sendSuccess(res, 200, 'Result deleted.', { _id: result._id });
});

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  createResult,
  bulkCreateResults,
  uploadResultsCSV,
  getResults,
  getResultById,
  updateResult,
  deleteResult,
};