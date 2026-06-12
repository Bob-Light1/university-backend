'use strict';

/**
 * @file result.service.js — API inter-modules du domaine result.
 *
 * Consommateurs :
 *   - staff : countPublishedResults, listCampusResults
 *   - mentor : countPublishedResults, getRecentResultsForStudents, listCampusResults
 *   - student : getRecentResultsForStudent (dashboard)
 *   - parent : listStudentPublishedResults, listStudentResultComments,
 *     getRecentResultsForChild, listStudentTranscripts, signTranscriptByParent
 *   - academic-print : getTranscriptForPrint
 */

const { Result }          = require('./models/result.model');
const { FinalTranscript } = require('./models/final-transcript.model');

// ── Results : compteurs ───────────────────────────────────────────────────────

/**
 * Nombre de résultats PUBLISHED d'un campus (option : restreints à des étudiants).
 * `withDeleted` préserve une incohérence historique : le dashboard mentor ne
 * filtrait pas isDeleted, contrairement au dashboard staff.
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
  return Result.countDocuments(filter);
};

// ── Results : listes paginées ─────────────────────────────────────────────────

/**
 * Liste paginée des résultats PUBLISHED d'un campus (staff/mentor readonly).
 * Tri createdAt desc, populates student/subject/class.
 * `withDeleted` : même incohérence historique que countPublishedResults
 * (mentor ne filtrait pas isDeleted).
 * @param {Object} p
 * @param {ObjectId|string} p.campusId
 * @param {Array} [p.studentIds] — périmètre mentor
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
  const [docs, total] = await Promise.all([
    Result.find(filter)
      .select('-__v')
      .populate('student', 'firstName lastName matricule profileImage')
      .populate('subject', 'subject_name')
      .populate('class',   'className')
      .sort({ createdAt: -1 })
      .skip(skip).limit(Number(limit)).lean(),
    Result.countDocuments(filter),
  ]);
  return { docs, total };
};

/**
 * Résultats PUBLISHED d'un étudiant pour le portail parent (paginé).
 * Tri examDate/publishedAt desc, virtuals inclus, champs d'audit exclus.
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
  const [results, total] = await Promise.all([
    Result.find(filter)
      .select('-auditLog -verificationToken -dropoutRiskScore -__v')
      .populate('subject',  'subject_name subject_code')
      .populate('teacher',  'firstName lastName email')
      .populate('class',    'className level')
      .sort({ examDate: -1, publishedAt: -1 })
      .skip(skipN)
      .limit(Number(limit))
      .lean({ virtuals: true }),
    Result.countDocuments(filter),
  ]);
  return { results, total };
};

/**
 * Commentaires pédagogiques (remarques/forces/axes) des résultats PUBLISHED
 * d'un étudiant — portail parent, paginé.
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
      { teacherRemarks:      { $exists: true, $ne: null, $ne: '' } },
      { classManagerRemarks: { $exists: true, $ne: null, $ne: '' } },
      { strengths:           { $exists: true, $ne: null, $ne: '' } },
      { improvements:        { $exists: true, $ne: null, $ne: '' } },
    ],
  };
  if (academicYear) filter.academicYear = academicYear;
  if (semester)     filter.semester     = semester;

  const skipN = skip != null ? skip : (Number(page) - 1) * Number(limit);
  const [comments, total] = await Promise.all([
    Result.find(filter)
      .select('academicYear semester evaluationTitle evaluationType teacherRemarks classManagerRemarks strengths improvements publishedAt subject teacher')
      .populate('subject', 'subject_name subject_code')
      .populate('teacher', 'firstName lastName')
      .sort({ publishedAt: -1 })
      .skip(skipN)
      .limit(Number(limit))
      .lean({ virtuals: true }),
    Result.countDocuments(filter),
  ]);
  return { comments, total };
};

// ── Results : derniers résultats (dashboards) ─────────────────────────────────

/** Dashboard étudiant : 5 derniers résultats PUBLISHED (scores inclus). */
const getRecentResultsForStudent = (studentId, campusId, limit = 5) =>
  Result.find({
    student:      studentId,
    schoolCampus: campusId,
    status:       'PUBLISHED',
    isDeleted:    false,
  })
    .select('evaluationTitle evaluationType academicYear semester normalizedScore score maxScore gradeBand publishedAt subject')
    .populate('subject', 'subject_name subject_code')
    .sort({ publishedAt: -1 })
    .limit(limit)
    .lean({ virtuals: true });

/** Dashboard parent : 5 derniers résultats PUBLISHED d'un enfant. */
const getRecentResultsForChild = (studentId, campusId, limit = 5) =>
  Result.find({
    student:      studentId,
    schoolCampus: campusId,
    status:       'PUBLISHED',
    isDeleted:    false,
  })
    .select('evaluationTitle evaluationType academicYear semester normalizedScore gradeBand publishedAt subject')
    .populate('subject', 'subject_name')
    .sort({ publishedAt: -1 })
    .limit(limit)
    .lean({ virtuals: true });

/** Dashboard mentor : 5 derniers résultats PUBLISHED de ses étudiants. */
const getRecentResultsForStudents = (studentIds, campusId, limit = 5) =>
  Result.find({
    student:      { $in: studentIds },
    schoolCampus: campusId,
    status:       'PUBLISHED',
  })
    .select('student subject score maxScore grade evaluationTitle createdAt')
    .populate('student', 'firstName lastName profileImage')
    .populate('subject', 'subject_name')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

// ── Transcripts ───────────────────────────────────────────────────────────────

/**
 * Bulletins VALIDATED/SEALED d'un étudiant (portail parent).
 * @returns {Promise<Object[]>} lean (virtuals inclus)
 */
const listStudentTranscripts = ({ studentId, campusId, academicYear, semester }) => {
  const filter = {
    student:      studentId,
    schoolCampus: campusId,
    status:       { $in: ['VALIDATED', 'SEALED'] },
  };
  if (academicYear) filter.academicYear = academicYear;
  if (semester)     filter.semester     = semester;

  return FinalTranscript.find(filter)
    .select('-__v')
    .populate('class',   'className level')
    .populate('student', 'firstName lastName profileImage')
    .sort({ academicYear: -1, semester: 1 })
    .lean({ virtuals: true });
};

/**
 * Accusé de lecture parent sur un bulletin. signByParent lève une erreur
 * (avec statusCode) si déjà signé ou statut invalide — propagée à l'appelant.
 * @returns {Promise<{transcriptId, parentSignature}|null>} null si introuvable
 */
const signTranscriptByParent = async ({ transcriptId, studentId, campusId, parentId, ip, method = 'click' }) => {
  const transcript = await FinalTranscript.findOne({
    _id:          transcriptId,
    student:      studentId,
    schoolCampus: campusId,
  });
  if (!transcript) return null;

  await transcript.signByParent(parentId, ip, method);
  return { transcriptId: transcript._id, parentSignature: transcript.parentSignature };
};

/**
 * Bulletin d'un étudiant pour impression PDF (academic-print).
 * @returns {Promise<Object|null>} lean
 */
const getTranscriptForPrint = ({ studentId, campusId, academicYear, semester }) =>
  FinalTranscript.findOne({
    student:      studentId,
    schoolCampus: campusId,
    academicYear,
    semester,
  }).lean();

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
};
