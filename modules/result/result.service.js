'use strict';

/**
 * @file result.service.js — inter-module API of the result domain.
 *
 * Consumers:
 *   - staff: countPublishedResults, listCampusResults
 *   - mentor: countPublishedResults, getRecentResultsForStudents, listCampusResults
 *   - student: getRecentResultsForStudent (dashboard)
 *   - parent: listStudentPublishedResults, listStudentResultComments,
 *     getRecentResultsForChild, listStudentTranscripts, signTranscriptByParent
 *   - academic-print: getTranscriptForPrint
 *   - ai: getCampusOverviewAggregates, getDropoutRiskDistribution,
 *     isValidSemester, isValidAcademicYear (AI analytics aggregates, M5 —
 *     PII-free figures only)
 *
 * All persistence goes through result.repository (step 0 pre-Postgres);
 * the service keeps the inter-module API and the building of business filters.
 */

const mongoose = require('mongoose');
const resultRepo = require('./result.repository');
const { SEMESTER } = require('./models/result.model');

// ── Results : compteurs ───────────────────────────────────────────────────────

/**
 * Number of PUBLISHED results of a campus (option: restricted to some students).
 * `withDeleted` preserves a historical inconsistency: the mentor dashboard did not
 * filter isDeleted, unlike the staff dashboard.
 * @param {Object} p
 * @param {ObjectId|string} p.campusId
 * @param {Array} [p.studentIds]
 * @param {boolean} [p.withDeleted=false]
 * @returns {Promise<number>}
 */
const countPublishedResults = ({ campusId, studentIds, withDeleted = false }) => {
  const filter = { schoolCampus: campusId, status: 'PUBLISHED' };
  if (!withDeleted) filter.isDeleted = false;
  if (studentIds)   filter.student   = { $in: studentIds };
  return resultRepo.countResults(filter);
};

// ── Results: paginated lists ─────────────────────────────────────────────────

/**
 * Paginated list of a campus's PUBLISHED results (staff/mentor readonly).
 * Sorted createdAt desc, populates student/subject/class.
 * `withDeleted`: same historical inconsistency as countPublishedResults
 * (mentor did not filter isDeleted).
 * @param {Object} p
 * @param {ObjectId|string} p.campusId
 * @param {Array} [p.studentIds] — mentor scope
 * @param {ObjectId|string} [p.studentId], [p.subjectId], [p.classId]
 * @param {string} [p.academicYear], [p.semester], [p.evaluationType], [p.examPeriod]
 * @param {number} [p.page=1], [p.limit=20]
 * @param {boolean} [p.withDeleted=false]
 * @returns {Promise<{docs: Object[], total: number}>}
 */
const listCampusResults = async ({
  campusId, studentIds, studentId, subjectId, classId,
  academicYear, semester, evaluationType, examPeriod,
  page = 1, limit = 20, withDeleted = false,
}) => {
  const filter = { schoolCampus: campusId, status: 'PUBLISHED' };
  if (!withDeleted)   filter.isDeleted      = false;
  if (studentIds)     filter.student        = { $in: studentIds };
  if (studentId)      filter.student        = studentId;
  if (subjectId)      filter.subject        = subjectId;
  if (classId)        filter.class          = classId;
  if (academicYear)   filter.academicYear   = academicYear;
  if (semester)       filter.semester       = semester;
  if (evaluationType) filter.evaluationType = evaluationType;
  if (examPeriod)     filter.examPeriod     = examPeriod;

  const skip = (Number(page) - 1) * Number(limit);
  return resultRepo.paginateCampusResults(filter, { skip, limit: Number(limit) });
};

/**
 * A student's PUBLISHED results for the parent portal (paginated).
 * Sorted examDate/publishedAt desc, virtuals included, audit fields excluded.
 * @returns {Promise<{results: Object[], total: number}>}
 */
const listStudentPublishedResults = async ({
  studentId, campusId, academicYear, semester, subjectId, page = 1, limit = 20, skip,
}) => {
  const filter = {
    student:      studentId,
    schoolCampus: campusId,
    status:       'PUBLISHED',
    isDeleted:    false,
  };
  if (academicYear) filter.academicYear = academicYear;
  if (semester)     filter.semester     = semester;
  if (subjectId)    filter.subject      = subjectId;

  const skipN = skip != null ? skip : (Number(page) - 1) * Number(limit);
  return resultRepo.paginateStudentPublishedResults(filter, { skip: skipN, limit: Number(limit) });
};

/**
 * Educational comments (remarks/strengths/areas) of a student's PUBLISHED
 * results — parent portal, paginated.
 * @returns {Promise<{comments: Object[], total: number}>}
 */
const listStudentResultComments = async ({
  studentId, campusId, academicYear, semester, page = 1, limit = 20, skip,
}) => {
  const filter = {
    student:      studentId,
    schoolCampus: campusId,
    status:       'PUBLISHED',
    isDeleted:    false,
    // At least one comment field must exist
    $or: [
      { teacherRemarks:      { $exists: true, $nin: [null, ''] } },
      { classManagerRemarks: { $exists: true, $nin: [null, ''] } },
      { strengths:           { $exists: true, $nin: [null, ''] } },
      { improvements:        { $exists: true, $nin: [null, ''] } },
    ],
  };
  if (academicYear) filter.academicYear = academicYear;
  if (semester)     filter.semester     = semester;

  const skipN = skip != null ? skip : (Number(page) - 1) * Number(limit);
  return resultRepo.paginateStudentResultComments(filter, { skip: skipN, limit: Number(limit) });
};

// ── Results: latest results (dashboards) ─────────────────────────────────

/** Student dashboard: 5 latest PUBLISHED results (scores included). */
const getRecentResultsForStudent = (studentId, campusId, limit = 5) =>
  resultRepo.findRecentResultsForStudent({
    student:      studentId,
    schoolCampus: campusId,
    status:       'PUBLISHED',
    isDeleted:    false,
  }, limit);

/** Parent dashboard: 5 latest PUBLISHED results of a child. */
const getRecentResultsForChild = (studentId, campusId, limit = 5) =>
  resultRepo.findRecentResultsForChild({
    student:      studentId,
    schoolCampus: campusId,
    status:       'PUBLISHED',
    isDeleted:    false,
  }, limit);

/** Mentor dashboard: 5 latest PUBLISHED results of its students.
 *  (historical inconsistency preserved: no isDeleted filter). */
const getRecentResultsForStudents = (studentIds, campusId, limit = 5) =>
  resultRepo.findRecentResultsForStudents({
    student:      { $in: studentIds },
    schoolCampus: campusId,
    status:       'PUBLISHED',
  }, limit);

// ── Transcripts ───────────────────────────────────────────────────────────────

/**
 * A student's VALIDATED/SEALED transcripts (parent portal).
 * @returns {Promise<Object[]>} lean (virtuals included)
 */
const listStudentTranscripts = ({ studentId, campusId, academicYear, semester }) => {
  const filter = {
    student:      studentId,
    schoolCampus: campusId,
    status:       { $in: ['VALIDATED', 'SEALED'] },
  };
  if (academicYear) filter.academicYear = academicYear;
  if (semester)     filter.semester     = semester;

  return resultRepo.listStudentTranscripts(filter);
};

/**
 * Parent read receipt on a transcript. signByParent throws an error
 * (with statusCode) if already signed or status invalid — propagated to the caller.
 * @returns {Promise<{transcriptId, parentSignature}|null>} null if not found
 */
const signTranscriptByParent = async ({ transcriptId, studentId, campusId, parentId, ip, method = 'click' }) => {
  const transcript = await resultRepo.findTranscriptForSignature({ transcriptId, studentId, campusId });
  if (!transcript) return null;

  await transcript.signByParent(parentId, ip, method);
  return { transcriptId: transcript._id, parentSignature: transcript.parentSignature };
};

/**
 * A student's transcript for PDF printing (academic-print).
 * @returns {Promise<Object|null>} lean
 */
const getTranscriptForPrint = ({ studentId, campusId, academicYear, semester }) =>
  resultRepo.findTranscriptForPrint({ studentId, campusId, academicYear, semester });

// ── AI analytics aggregates (design doc §8, M5) ──────────────────────────────
// Deterministic campus-scoped figures consumed by /internal/ai/aggregates —
// the AI narrates these numbers, it never computes any (ADR-4). No PII leaves
// these facades: counters, rates and distributions only.

/** Academic year filter format accepted by the aggregate facades (model rule). */
const isValidAcademicYear = (value) => /^\d{4}-\d{4}$/.test(String(value));

/** Semester enum guard (single source of truth: the Result model enum). */
const isValidSemester = (value) => Object.values(SEMESTER).includes(value);

/**
 * Campus results overview: status/type/period facets + general stats
 * (avg normalized score, passing rate, retake-eligible, at-risk, absents).
 * Same pipeline as GET /api/results/campus/overview — one source of figures.
 * @param {Object} p
 * @param {ObjectId|string} p.campusId
 * @param {string} [p.academicYear] — 'YYYY-YYYY'
 * @param {string} [p.semester] — SEMESTER enum value
 * @returns {Promise<Object>} flat figures object (no document, no PII)
 */
const getCampusOverviewAggregates = async ({ campusId, academicYear, semester }) => {
  // Aggregation pipelines do NOT auto-cast (unlike find) — a string campus id
  // would silently match nothing.
  const matchFilter = { isDeleted: false, schoolCampus: new mongoose.Types.ObjectId(String(campusId)) };
  if (academicYear && isValidAcademicYear(academicYear)) matchFilter.academicYear = academicYear;
  if (semester && isValidSemester(semester)) matchFilter.semester = semester;

  const [facets] = await resultRepo.aggregateCampusOverview(matchFilter);
  const overview = {
    byStatus:     Object.fromEntries((facets?.byStatus     || []).map((s) => [s._id, s.count])),
    byEvalType:   Object.fromEntries((facets?.byEvalType   || []).map((s) => [s._id, s.count])),
    byExamPeriod: Object.fromEntries((facets?.byExamPeriod || []).map((s) => [s._id, s.count])),
    ...(facets?.generalStats?.[0] || {}),
  };
  delete overview._id;
  return overview;
};

/**
 * Campus dropout-risk distribution over PUBLISHED/ARCHIVED results: one entry
 * per distinct student (worst score), bucketed low (<30) / moderate (30-59) /
 * high (≥60 — same threshold as the overview `atRisk` facet).
 * @param {Object} p
 * @param {ObjectId|string} p.campusId
 * @param {string} [p.academicYear], [p.semester]
 * @returns {Promise<Object>} { studentsAssessed, avgRiskScore, lowRisk, moderateRisk, highRisk }
 */
/**
 * Self-scoped grade summary of ONE student (AI chat tool §7 — resolves the
 * caller's own PUBLISHED results only). Deterministic figures computed by the
 * ERP (ADR-4). The student id and campus are the S2S subject's — never a value
 * the LLM supplied. Returns a flat, PII-free object.
 * @param {Object} p
 * @param {ObjectId|string} p.studentId — the S2S subject (self).
 * @param {ObjectId|string} p.campusId
 * @param {string} [p.academicYear], [p.semester]
 * @returns {Promise<Object>} { published, average, passingCount, passingRate, best, worst }
 */
const getStudentGradesSummary = async ({ studentId, campusId, academicYear, semester }) => {
  const matchFilter = {
    // Aggregation pipelines do not auto-cast (unlike find).
    student:      new mongoose.Types.ObjectId(String(studentId)),
    schoolCampus: new mongoose.Types.ObjectId(String(campusId)),
    status:       'PUBLISHED',
    isDeleted:    false,
  };
  if (academicYear && isValidAcademicYear(academicYear)) matchFilter.academicYear = academicYear;
  if (semester && isValidSemester(semester)) matchFilter.semester = semester;

  const [summary] = await resultRepo.aggregateStudentGradesSummary(matchFilter);
  return summary
    || { published: 0, average: null, passingCount: 0, passingRate: null, best: null, worst: null };
};

const getDropoutRiskDistribution = async ({ campusId, academicYear, semester }) => {
  const matchFilter = {
    // Explicit cast: aggregation pipelines do not auto-cast campus ids.
    schoolCampus: new mongoose.Types.ObjectId(String(campusId)),
    status:       { $in: ['PUBLISHED', 'ARCHIVED'] },
    isDeleted:    false,
  };
  if (academicYear && isValidAcademicYear(academicYear)) matchFilter.academicYear = academicYear;
  if (semester && isValidSemester(semester)) matchFilter.semester = semester;

  const [distribution] = await resultRepo.aggregateDropoutRiskDistribution(matchFilter);
  return distribution
    || { studentsAssessed: 0, avgRiskScore: null, lowRisk: 0, moderateRisk: 0, highRisk: 0 };
};

module.exports = {
  countPublishedResults,
  listCampusResults,
  listStudentPublishedResults,
  listStudentResultComments,
  getRecentResultsForStudent,
  getRecentResultsForChild,
  getRecentResultsForStudents,
  listStudentTranscripts,
  signTranscriptByParent,
  getTranscriptForPrint,
  // AI analytics aggregates (M5)
  getCampusOverviewAggregates,
  getDropoutRiskDistribution,
  getStudentGradesSummary,
  isValidAcademicYear,
  isValidSemester,
};
