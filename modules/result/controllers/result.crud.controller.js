'use strict';

/**
 * @file result.crud.controller.js
 * @description CRUD operations on academic results.
 *
 *  Handled endpoints :
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

const { RESULT_STATUS, EVALUATION_TYPE, SEMESTER } = require('../models/result.model');
const resultRepo = require('../result.repository');
const { getClassCampusRef, isTeacherInClass } = require('../../class').service; // class module facade (§3)
const { isTeacherOfSubject } = require('../../subject').service; // subject module facade (§3)

const {
  asyncHandler,
  sendSuccess,
  sendError,
  sendCreated,
  sendPaginated,
  sendNotFound,
  sendForbidden,
  handleDuplicateKeyError,
} = require('../../../shared/utils/response-helpers');

const {
  isValidObjectId,
} = require('../../../shared/utils/validation-helpers');
// Lazy require : student.dashboard consumes the result facade (result ↔ student cycle)
const studentService = () => require('../../student').service;
const validateStudentBelongsToCampus = (...args) =>
  studentService().validateStudentBelongsToCampus(...args);

const {
  isGlobalRole,
  isManagerRole,
  getCampusFilter,
  resolveCampusId,
  validateResultContext,
  validateResultIds,
  parsePositiveInt,
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

  // A teacher may only attribute a result to themselves — the body teacher is
  // ignored for TEACHER role (managers/admins may grade on behalf of any teacher).
  const effectiveTeacher = req.user.role === 'TEACHER' ? req.user.id : teacher;

  // IDs validation
  const idError = validateResultIds({ student, classId, subject, teacher: effectiveTeacher });
  if (idError) return sendError(res, 400, idError);
  if (gradingScale && !isValidObjectId(gradingScale))
    return sendError(res, 400, 'Invalid gradingScale.');

  // Contextual fields validation
  const ctxError = validateResultContext({ evaluationType, semester, academicYear, score, maxScore });
  if (ctxError) return sendError(res, 400, ctxError);

  if (!evaluationTitle?.trim()) return sendError(res, 400, 'evaluationTitle is required.');

  // Campus isolation : does the student belong to the campus ?
  if (!isGlobalRole(req.user.role)) {
    const belongs = await validateStudentBelongsToCampus(student, resolvedCampus);
    if (!belongs) return sendForbidden(res, 'Student does not belong to your campus.');
  }

  // Pedagogical integrity — the attributed teacher must teach this subject AND be
  // assigned to this class (mirrors bulkCreateResults; subject↔class is not modelled
  // directly, so teacher↔subject + teacher↔class is the meaningful proxy).
  const [teachesSubject, assignedToClass] = await Promise.all([
    isTeacherOfSubject({ subjectId: subject, teacherId: effectiveTeacher, campusId: resolvedCampus }),
    isTeacherInClass({ classId, teacherId: effectiveTeacher, campusId: resolvedCampus }),
  ]);
  if (!teachesSubject)
    return sendError(res, 422, 'The selected teacher does not teach this subject. Assign the teacher to the subject first.');
  if (!assignedToClass)
    return sendError(res, 422, 'The selected teacher is not assigned to this class. Assign the teacher to the class first.');

  try {
    const result = await resultRepo.createResult({
      student, class: classId, subject, teacher: effectiveTeacher,
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
 * Bulk entry for an entire class.
 *
 * Body : {
 *   classId, subjectId, teacherId,
 *   evaluationType, evaluationTitle, academicYear, semester,
 *   maxScore, examDate?, examPeriod?, gradingScale?,
 *   results: [{ studentId, score, coefficient?, teacherRemarks?,
 *               examAttendance?, strengths?, improvements? }]
 * }
 *
 * Returns 207 Multi-Status with the detail of insertions and errors.
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

  // A teacher may only attribute results to themselves — the body teacherId is
  // ignored for TEACHER role (managers/admins may grade on behalf of any teacher).
  const effectiveTeacherId = req.user.role === 'TEACHER' ? req.user.id : teacherId;

  if (!isValidObjectId(classId))   return sendError(res, 400, 'Invalid classId.');
  if (!isValidObjectId(subjectId)) return sendError(res, 400, 'Invalid subjectId.');
  if (!isValidObjectId(effectiveTeacherId)) return sendError(res, 400, 'Invalid teacherId.');
  if (gradingScale && !isValidObjectId(gradingScale))
    return sendError(res, 400, 'Invalid gradingScale.');
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
  const classDoc = await getClassCampusRef(classId);
  if (!classDoc) return sendNotFound(res, 'Class');
  if (!isGlobalRole(req.user.role) && classDoc.schoolCampus.toString() !== resolvedCampus.toString())
    return sendForbidden(res, 'Class does not belong to your campus.');

  // Pedagogical integrity — the teacher the grades are attributed to must teach
  // this subject AND be assigned to this class. (subject↔class is not modelled
  // directly; teacher↔subject + teacher↔class is the meaningful proxy and also
  // validates that the subject belongs to the campus.) 422 = well-formed but
  // semantically invalid, distinct from a malformed-input 400.
  const [teachesSubject, assignedToClass] = await Promise.all([
    isTeacherOfSubject({ subjectId, teacherId: effectiveTeacherId, campusId: resolvedCampus }),
    isTeacherInClass({ classId, teacherId: effectiveTeacherId, campusId: resolvedCampus }),
  ]);
  if (!teachesSubject)
    return sendError(res, 422, 'The selected teacher does not teach this subject. Assign the teacher to the subject first.');
  if (!assignedToClass)
    return sendError(res, 422, 'The selected teacher is not assigned to this class. Assign the teacher to the class first.');

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
  const enrolledDocs = await studentService().listStudentIds({
    classIds: [new mongoose.Types.ObjectId(classId)],
    campusId: new mongoose.Types.ObjectId(resolvedCampus),
  });
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
    const att = examAttendance || 'present';
    if (!['present', 'absent', 'excused'].includes(att)) {
      errors.push({ index: i, studentId, error: 'examAttendance must be present, absent or excused.' }); continue;
    }
    const coeffNum = ec != null ? Number(ec) : 1;
    if (!Number.isFinite(coeffNum) || coeffNum < 0) {
      errors.push({ index: i, studentId, error: 'coefficient must be a number ≥ 0.' }); continue;
    }

    toInsert.push({
      student:         studentId,
      class:           classId,
      subject:         subjectId,
      teacher:         effectiveTeacherId,
      score:           s,
      maxScore:        Number(maxScore),
      coefficient:     coeffNum,
      evaluationType,
      evaluationTitle: evaluationTitle.trim(),
      academicYear,
      semester,
      examDate:        examDate || null,
      examPeriod:      examPeriod || null,
      examAttendance:  att,
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
    inserted = await resultRepo.insertManyResults(toInsert);
  } catch (err) {
    // Partial-failure path for unordered insertMany. The presence of writeErrors
    // is the reliable signal; the error class is MongoBulkWriteError on the
    // mongodb v6 driver (the old 'BulkWriteError' name no longer matches).
    if (err.writeErrors || err.code === 11000 || /BulkWriteError/i.test(err.name || '')) {
      inserted   = err.insertedDocs  || [];
      duplicates = (err.writeErrors  || []).map((e) => {
        const idx = e.index ?? e.err?.index;
        return {
          index:     idx,
          studentId: toInsert[idx]?.student,
          error:     'Duplicate result for this evaluation.',
        };
      });
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
 * Bulk import via CSV file. Expected columns :
 *   studentId, score, coefficient (opt), teacherRemarks (opt),
 *   examAttendance (opt), strengths (opt), improvements (opt)
 *
 * The contextual parameters (classId, subjectId, etc.) are provided in form-data
 * as for /bulk.
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

  // Reuse of bulkCreateResults after normalizing the CSV data
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
 * Paginated list of results with multidimensional filters.
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

  // STUDENTs only see their published/archived grades
  if (req.user.role === 'STUDENT') {
    filter.student = req.user.id;
    filter.status  = { $in: [RESULT_STATUS.PUBLISHED, RESULT_STATUS.ARCHIVED] };
  }

  // TEACHERs are scoped to their own results (least privilege). Without this a
  // teacher could omit the teacherId query param and read every colleague's
  // grades within the campus, contradicting the documented portal contract.
  if (req.user.role === 'TEACHER') {
    filter.teacher = req.user.id;
  }

  const pageNum  = parsePositiveInt(page,  1);
  const limitNum = parsePositiveInt(limit, 50);

  const { docs: results, total } = await resultRepo.paginateResults(filter, {
    skip:  (pageNum - 1) * limitNum,
    limit: limitNum,
  });

  return sendPaginated(res, 200, 'Results fetched.', results, { total, page: pageNum, limit: limitNum });
});

/**
 * GET /api/results/:id
 * Full detail of a result, with audit log and pedagogical feedback.
 */
const getResultById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid result ID.');

  const result = await resultRepo.findResultByIdPopulated(id);

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
 * Updates a DRAFT result (or SUBMITTED for managers).
 * For PUBLISHED/ARCHIVED, use PATCH /audit/:id (ADMIN/DIRECTOR).
 *
 * Body : partial fields among the allowed fields.
 */
const updateResult = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid result ID.');

  const result = await resultRepo.findResultForWrite(id);
  if (!result) return sendNotFound(res, 'Result');

  // Rights check via canModify [S3-1]
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
  // classManagerRemarks can only be modified by managers
  if (req.body.classManagerRemarks !== undefined && !isManagerRole(req.user.role)) {
    return sendForbidden(res, 'Only managers can add class manager remarks.');
  }

  // Numeric integrity — the model has no max bound tying score to maxScore, so a
  // PUT could otherwise persist a score above the maximum (e.g. 999/20). Validate
  // against the effective values (incoming overrides, else the stored ones).
  if (req.body.maxScore !== undefined) {
    const m = Number(req.body.maxScore);
    if (!Number.isFinite(m) || m < 1) return sendError(res, 400, 'maxScore must be at least 1.');
  }
  if (req.body.coefficient !== undefined) {
    const c = Number(req.body.coefficient);
    if (!Number.isFinite(c) || c < 0) return sendError(res, 400, 'coefficient cannot be negative.');
  }
  if (req.body.score !== undefined) {
    const s = Number(req.body.score);
    const effectiveMax = req.body.maxScore !== undefined ? Number(req.body.maxScore) : result.maxScore;
    if (!Number.isFinite(s) || s < 0) return sendError(res, 400, 'Score cannot be negative.');
    if (s > effectiveMax) return sendError(res, 400, `Score (${s}) cannot exceed maxScore (${effectiveMax}).`);
  }

  allowed.forEach((field) => {
    if (req.body[field] !== undefined) result[field] = req.body[field];
  });

  // If the manager adds classManagerRemarks, we track who did it
  if (req.body.classManagerRemarks !== undefined) {
    result.classManager = new mongoose.Types.ObjectId(req.user.id);
  }

  await resultRepo.saveResultDoc(result);
  return sendSuccess(res, 200, 'Result updated.', result);
});

// ─── DELETE (soft) ────────────────────────────────────────────────────────────

/**
 * DELETE /api/results/:id
 * Soft-delete. DRAFT only for TEACHER/CAMPUS_MANAGER.
 * ADMIN/DIRECTOR peuvent supprimer n'importe quel statut.
 */
const deleteResult = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid result ID.');

  const result = await resultRepo.findResultForWrite(id);
  if (!result) return sendNotFound(res, 'Result');

  if (!isGlobalRole(req.user.role) &&
      result.schoolCampus.toString() !== req.user.campusId?.toString())
    return sendForbidden(res, 'Access denied.');

  // A teacher may only delete their own DRAFT (campus scope alone would let a
  // teacher delete a colleague's draft in the same campus).
  if (req.user.role === 'TEACHER' && result.teacher.toString() !== req.user.id)
    return sendForbidden(res, 'You can only delete your own results.');

  if (result.status !== RESULT_STATUS.DRAFT && !isGlobalRole(req.user.role))
    return sendError(res, 400, 'Only DRAFT results can be deleted. Use ADMIN access for published results.');

  if (result.periodLocked && !isGlobalRole(req.user.role))
    return sendError(res, 403, 'This semester is locked.');

  result.isDeleted = true;
  result.deletedAt = new Date();
  result.deletedBy = req.user.id;
  await resultRepo.saveResultDoc(result);

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