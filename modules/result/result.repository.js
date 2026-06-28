'use strict';

/**
 * @file result.repository.js — data access layer of the result module.
 *
 * ONLY file allowed to touch the 3 owned models :
 *   - Result          (result.model)
 *   - FinalTranscript (final-transcript.model)
 *   - GradingScale    (grading-scale.model)
 *
 * Controllers (crud / workflow / analytics) and the inter-module service go
 * exclusively through it. Reads `.lean()` (or `.lean({ virtuals: true })` where
 * the historical output exposed virtuals) ; hook-driven writes via
 * load→mutate→save (preserves gradeBand/verificationToken/normalizedScore and
 * the append-only auditLog), otherwise atomic operators. The aggregation
 * pipelines (transcript on the fly, campus overview, distinct students of a
 * lock) live here ; the caller provides the `$match` already cast to ObjectId.
 * Campus isolation filters are built by the caller and passed as-is.
 *
 * Accepted exceptions (stay out of the repo) :
 *   - Domain constants (RESULT_STATUS, EVALUATION_TYPE, SEMESTER,
 *     GRADING_SYSTEM, TRANSCRIPT_STATUS) : imported directly by the
 *     controllers/helper — these are enums, not a persistence access.
 *   - Model statics/instance methods (computeDropoutRisk,
 *     getClassDistribution, generateForStudent, canModify, addAuditEntry,
 *     signByParent…) : business logic of the model layer, invoked HERE or
 *     carried by the returned doc.
 */

const mongoose = require('mongoose');

const { Result }          = require('./models/result.model');
const { FinalTranscript } = require('./models/final-transcript.model');
const { GradingScale }    = require('./models/grading-scale.model');

// Populate shapes for result reads (query shape — lives here).
const RESULT_LIST_POPULATE = [
  { path: 'student', select: 'firstName lastName matricule' },
  { path: 'subject', select: 'subject_name subject_code coefficient' },
  { path: 'teacher', select: 'firstName lastName email' },
  { path: 'class',   select: 'className' },
];
const RESULT_DETAIL_POPULATE = [
  { path: 'student',      select: 'firstName lastName matricule email' },
  { path: 'subject',      select: 'subject_name subject_code coefficient' },
  { path: 'teacher',      select: 'firstName lastName email' },
  { path: 'class',        select: 'className' },
  { path: 'classManager', select: 'firstName lastName email' },
  { path: 'gradingScale', select: 'name system maxScore passMark bands' },
];

const applyPopulate = (query, paths) => {
  for (const p of paths) query = query.populate(p);
  return query;
};

// ─────────────────────────────────────────────────────────────────────────────
// RESULT — transaction sessions
// ─────────────────────────────────────────────────────────────────────────────

/** Opens a Mongoose session (RETAKE publication transaction). */
const startSession = () => mongoose.startSession();

// ─────────────────────────────────────────────────────────────────────────────
// RESULT — creation
// ─────────────────────────────────────────────────────────────────────────────

/** Creates a result (triggers pre('validate')/pre('save') : gradeBand…). */
const createResult = (payload) => Result.create(payload);

/**
 * Unordered bulk insertion (class entry). `ordered:false` lets
 * duplicates through ; the caller handles err.insertedDocs / err.writeErrors.
 */
const insertManyResults = (docs) => Result.insertMany(docs, { ordered: false });

// ─────────────────────────────────────────────────────────────────────────────
// RESULT — reads (controller)
// ─────────────────────────────────────────────────────────────────────────────

/** Paginated list + count (getResults). Filter composed by the caller. */
const paginateResults = async (filter, { skip, limit }) => {
  let query = Result.find(filter).sort({ createdAt: -1 });
  query = applyPopulate(query, RESULT_LIST_POPULATE);
  const [docs, total] = await Promise.all([
    query.skip(skip).limit(limit).lean(),
    Result.countDocuments(filter),
  ]);
  return { docs, total };
};

/** Full detail of a non-deleted result (lean, populate DETAIL). */
const findResultByIdPopulated = (id) =>
  applyPopulate(Result.findOne({ _id: id, isDeleted: false }), RESULT_DETAIL_POPULATE).lean();

/** Non-deleted result doc for writing (update / delete / workflow). */
const findResultForWrite = (id) => Result.findOne({ _id: id, isDeleted: false });

/** Result doc by id, session-aware (original grade of a RETAKE in transaction). */
const findResultById = (id, { session } = {}) =>
  Result.findById(id).session(session ?? null);

/** Result docs for writing (batch publication : needs the save hooks). */
const findResultsForWrite = (filter) => Result.find(filter);

// ─────────────────────────────────────────────────────────────────────────────
// RESULT — writes
// ─────────────────────────────────────────────────────────────────────────────

/** Persists a result doc (triggers the save hooks). `opts` : { session }. */
const saveResultDoc = (doc, opts) => doc.save(opts);

/** Bulk update of results (batch submission/lock). */
const updateManyResults = (filter, update) => Result.updateMany(filter, update);

/** Writes the dropout risk score (atomic, fire-and-forget). */
const setDropoutRiskScore = (id, risk) =>
  Result.updateOne({ _id: id }, { $set: { dropoutRiskScore: risk } });

// ─────────────────────────────────────────────────────────────────────────────
// RESULT — business statics (model layer logic)
// ─────────────────────────────────────────────────────────────────────────────

/** Computes a student's dropout risk (model static). */
const computeDropoutRisk = (studentId, campusId) =>
  Result.computeDropoutRisk(studentId, campusId);

/** Statistical distribution of an evaluation (model static). */
const getClassDistribution = (classId, subjectId, evaluationTitle, academicYear, semester) =>
  Result.getClassDistribution(classId, subjectId, evaluationTitle, academicYear, semester);

// ─────────────────────────────────────────────────────────────────────────────
// RESULT — aggregates (analytics / lock)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Distinct students of a lock scope (transcript generation).
 * `matchStage` provided already cast by the caller.
 */
const aggregateDistinctStudentsForLock = (matchStage) =>
  Result.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id:      '$student',
        classId:  { $first: '$class' },
        campusId: { $first: '$schoolCampus' },
      },
    },
  ]);

/**
 * Transcript computed on the fly (grouped by year/semester/subject).
 * `matchFilter` provided already cast by the caller (student as ObjectId).
 */
const aggregateStudentTranscript = (matchFilter) =>
  Result.aggregate([
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
        // Weighted by each evaluation's coefficient (mirrors computeGeneralAverage).
        subjectWeightedSum: { $sum: { $multiply: [{ $multiply: [{ $divide: ['$score', '$maxScore'] }, 20] }, { $ifNull: ['$coefficient', 1] }] } },
        subjectWeightTotal: { $sum: { $ifNull: ['$coefficient', 1] } },
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
            average:     { $cond: [{ $gt: ['$subjectWeightTotal', 0] }, { $round: [{ $divide: ['$subjectWeightedSum', '$subjectWeightTotal'] }, 2] }, null] },
            evaluations: '$evaluations',
          },
        },
      },
    },
    { $sort: { '_id.academicYear': -1, '_id.semester': 1 } },
  ]);

/**
 * Campus analytics view (status/type/period facets + general stats).
 * `matchFilter` provided by the caller. Returns the raw aggregate array.
 */
const aggregateCampusOverview = (matchFilter) =>
  Result.aggregate([
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
          { $match: { examPeriod: { $ne: null } } },
          { $group: { _id: '$examPeriod', count: { $sum: 1 } } },
        ],
        generalStats: [
          {
            $match: {
              status:    { $in: ['PUBLISHED', 'ARCHIVED'] },
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
              avgNormalized: { $round: ['$avgNormalized', 2] },
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

// ─────────────────────────────────────────────────────────────────────────────
// RESULT — specialized lists (controller)
// ─────────────────────────────────────────────────────────────────────────────

/** Retake list (student/subject populated, ascending score sort). */
const listRetakeResults = (filter) =>
  Result.find(filter)
    .populate('student', 'firstName lastName matricule email')
    .populate('subject', 'subject_name subject_code coefficient')
    .select('student subject score maxScore normalizedScore gradeBand evaluationTitle evaluationType')
    .sort({ normalizedScore: 1 })
    .lean();

/** Result authenticatable by QR token (public verification, lean). */
const findResultByVerificationToken = (token) =>
  Result.findOne({ verificationToken: token, isDeleted: false })
    .populate('student', 'firstName lastName matricule')
    .populate('subject', 'subject_name subject_code')
    .populate('class',   'className')
    .select('student subject class academicYear semester evaluationType evaluationTitle ' +
            'normalizedScore gradeBand publishedAt status examPeriod')
    .lean();

// ─────────────────────────────────────────────────────────────────────────────
// RESULT — inter-module service (counters / paginated lists / recents)
// ─────────────────────────────────────────────────────────────────────────────

/** Result counter (filter composed by the service). */
const countResults = (filter) => Result.countDocuments(filter);

/** Paginated campus list (staff/mentor readonly) : student/subject/class populated. */
const paginateCampusResults = async (filter, { skip, limit }) => {
  const [docs, total] = await Promise.all([
    Result.find(filter)
      .select('-__v')
      .populate('student', 'firstName lastName matricule profileImage')
      .populate('subject', 'subject_name')
      .populate('class',   'className')
      .sort({ createdAt: -1 })
      .skip(skip).limit(limit).lean(),
    Result.countDocuments(filter),
  ]);
  return { docs, total };
};

/** PUBLISHED results of a student (parent portal), virtuals included. */
const paginateStudentPublishedResults = async (filter, { skip, limit }) => {
  const [results, total] = await Promise.all([
    Result.find(filter)
      .select('-auditLog -verificationToken -dropoutRiskScore -__v')
      .populate('subject', 'subject_name subject_code')
      .populate('teacher', 'firstName lastName email')
      .populate('class',   'className level')
      .sort({ examDate: -1, publishedAt: -1 })
      .skip(skip).limit(limit).lean({ virtuals: true }),
    Result.countDocuments(filter),
  ]);
  return { results, total };
};

/** Pedagogical comments of a student's PUBLISHED results (parent). */
const paginateStudentResultComments = async (filter, { skip, limit }) => {
  const [comments, total] = await Promise.all([
    Result.find(filter)
      .select('academicYear semester evaluationTitle evaluationType teacherRemarks classManagerRemarks strengths improvements publishedAt subject teacher')
      .populate('subject', 'subject_name subject_code')
      .populate('teacher', 'firstName lastName')
      .sort({ publishedAt: -1 })
      .skip(skip).limit(limit).lean({ virtuals: true }),
    Result.countDocuments(filter),
  ]);
  return { comments, total };
};

/** Student dashboard : latest PUBLISHED results (scores included). */
const findRecentResultsForStudent = (filter, limit) =>
  Result.find(filter)
    .select('evaluationTitle evaluationType academicYear semester normalizedScore score maxScore gradeBand publishedAt subject')
    .populate('subject', 'subject_name subject_code')
    .sort({ publishedAt: -1 })
    .limit(limit)
    .lean({ virtuals: true });

/** Parent dashboard : latest PUBLISHED results of a child. */
const findRecentResultsForChild = (filter, limit) =>
  Result.find(filter)
    .select('evaluationTitle evaluationType academicYear semester normalizedScore gradeBand publishedAt subject')
    .populate('subject', 'subject_name')
    .sort({ publishedAt: -1 })
    .limit(limit)
    .lean({ virtuals: true });

/** Mentor dashboard : latest PUBLISHED results of their students. */
const findRecentResultsForStudents = (filter, limit) =>
  Result.find(filter)
    .select('student subject score maxScore grade evaluationTitle createdAt')
    .populate('student', 'firstName lastName profileImage')
    .populate('subject', 'subject_name')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

// ─────────────────────────────────────────────────────────────────────────────
// FINAL TRANSCRIPT
// ─────────────────────────────────────────────────────────────────────────────

/** Generation of a student's final transcript (model static). */
const generateTranscriptForStudent = (params) =>
  FinalTranscript.generateForStudent(params);

/** Stored final transcript of a student (student/class populated, lean). */
const findTranscriptForStudentPopulated = ({ studentId, academicYear, semester }) =>
  FinalTranscript.findOne({ student: studentId, academicYear, semester })
    .populate('student', 'firstName lastName matricule email')
    .populate('class',   'className')
    .lean();

/** Transcript doc by id for writing (validation / signature). */
const findTranscriptForWrite = (id) => FinalTranscript.findById(id);

/**
 * Minimal transcript projection of a lock scope, for class ranking.
 * `matchFilter` provided by the caller (academicYear/semester + campus scope).
 */
const listTranscriptsForRanking = (matchFilter) =>
  FinalTranscript.find(matchFilter).select('_id class generalAverage').lean();

/** Bulk-applies precomputed classRank/classTotal to transcripts. */
const bulkSetTranscriptRanks = (ops) =>
  ops && ops.length ? FinalTranscript.bulkWrite(ops) : Promise.resolve({ modifiedCount: 0 });

/** Persists a transcript doc (triggers the save hooks). */
const saveTranscriptDoc = (doc) => doc.save();

/** VALIDATED/SEALED transcripts of a student (parent portal, lean virtuals). */
const listStudentTranscripts = (filter) =>
  FinalTranscript.find(filter)
    .select('-__v')
    .populate('class',   'className level')
    .populate('student', 'firstName lastName profileImage')
    .sort({ academicYear: -1, semester: 1 })
    .lean({ virtuals: true });

/** Transcript doc scoped student/campus for parent signature (write). */
const findTranscriptForSignature = ({ transcriptId, studentId, campusId }) =>
  FinalTranscript.findOne({
    _id:          transcriptId,
    student:      studentId,
    schoolCampus: campusId,
  });

/** A student's transcript for PDF printing (academic-print, lean). */
const findTranscriptForPrint = ({ studentId, campusId, academicYear, semester }) =>
  FinalTranscript.findOne({
    student:      studentId,
    schoolCampus: campusId,
    academicYear,
    semester,
  }).lean();

// ─────────────────────────────────────────────────────────────────────────────
// GRADING SCALE
// ─────────────────────────────────────────────────────────────────────────────

/** Active grading scales of a campus (sort by default then name, lean). */
const listActiveGradingScales = (campusFilter) =>
  GradingScale.find({ isActive: true, ...campusFilter })
    .sort({ isDefault: -1, name: 1 })
    .lean();

/** Creates a grading scale (bands validation in pre-save). */
const createGradingScale = (payload) => GradingScale.create(payload);

/** Grading scale doc by id for writing (update). */
const findGradingScaleForWrite = (id) => GradingScale.findById(id);

/** Persists a grading scale doc (triggers the pre-save bands validation). */
const saveGradingScaleDoc = (doc) => doc.save();

module.exports = {
  // Result — transaction
  startSession,
  // Result — creation
  createResult,
  insertManyResults,
  // Result — lectures
  paginateResults,
  findResultByIdPopulated,
  findResultForWrite,
  findResultById,
  findResultsForWrite,
  // Result — writes
  saveResultDoc,
  updateManyResults,
  setDropoutRiskScore,
  // Result — business statics
  computeDropoutRisk,
  getClassDistribution,
  // Result — aggregates
  aggregateDistinctStudentsForLock,
  aggregateStudentTranscript,
  aggregateCampusOverview,
  // Result — specialized lists
  listRetakeResults,
  findResultByVerificationToken,
  // Result — service inter-modules
  countResults,
  paginateCampusResults,
  paginateStudentPublishedResults,
  paginateStudentResultComments,
  findRecentResultsForStudent,
  findRecentResultsForChild,
  findRecentResultsForStudents,
  // FinalTranscript
  generateTranscriptForStudent,
  findTranscriptForStudentPopulated,
  findTranscriptForWrite,
  listTranscriptsForRanking,
  bulkSetTranscriptRanks,
  saveTranscriptDoc,
  listStudentTranscripts,
  findTranscriptForSignature,
  findTranscriptForPrint,
  // GradingScale
  listActiveGradingScales,
  createGradingScale,
  findGradingScaleForWrite,
  saveGradingScaleDoc,
};
