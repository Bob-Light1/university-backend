'use strict';

/**
 * @file result.repository.js — couche d'accès aux données du module result.
 *
 * SEUL fichier autorisé à toucher les 3 models possédés :
 *   - Result          (result.model)
 *   - FinalTranscript (final-transcript.model)
 *   - GradingScale    (grading-scale.model)
 *
 * Controllers (crud / workflow / analytics) et service inter-modules passent
 * exclusivement par lui. Lectures `.lean()` (ou `.lean({ virtuals: true })` là
 * où la sortie historique exposait des virtuals) ; écritures à hook via
 * load→mutate→save (préserve gradeBand/verificationToken/normalizedScore et
 * l'auditLog append-only), sinon opérateurs atomiques. Les pipelines
 * d'agrégation (relevé à la volée, overview campus, distinct étudiants de
 * clôture) vivent ici ; l'appelant fournit le `$match` déjà casté en ObjectId.
 * Les filtres d'isolation campus sont construits par l'appelant et passés tels
 * quels.
 *
 * Exceptions assumées (restent hors repo) :
 *   - Constantes de domaine (RESULT_STATUS, EVALUATION_TYPE, SEMESTER,
 *     GRADING_SYSTEM, TRANSCRIPT_STATUS) : importées directement par les
 *     controllers/helper — ce sont des enums, pas un accès persistance.
 *   - Statiques/méthodes d'instance des models (computeDropoutRisk,
 *     getClassDistribution, generateForStudent, canModify, addAuditEntry,
 *     signByParent…) : logique métier de la couche model, invoquée ICI ou
 *     portée par le doc retourné.
 */

const mongoose = require('mongoose');

const { Result }          = require('./models/result.model');
const { FinalTranscript } = require('./models/final-transcript.model');
const { GradingScale }    = require('./models/grading-scale.model');

// Formes de populate des lectures de résultat (query shape — vit ici).
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
// RESULT — sessions de transaction
// ─────────────────────────────────────────────────────────────────────────────

/** Ouvre une session Mongoose (transaction de publication RETAKE). */
const startSession = () => mongoose.startSession();

// ─────────────────────────────────────────────────────────────────────────────
// RESULT — création
// ─────────────────────────────────────────────────────────────────────────────

/** Crée un résultat (déclenche pre('validate')/pre('save') : gradeBand…). */
const createResult = (payload) => Result.create(payload);

/**
 * Insertion massive non ordonnée (saisie de classe). `ordered:false` laisse
 * passer les doublons ; l'appelant traite err.insertedDocs / err.writeErrors.
 */
const insertManyResults = (docs) => Result.insertMany(docs, { ordered: false });

// ─────────────────────────────────────────────────────────────────────────────
// RESULT — lectures (controller)
// ─────────────────────────────────────────────────────────────────────────────

/** Liste paginée + compteur (getResults). Filtre composé par l'appelant. */
const paginateResults = async (filter, { skip, limit }) => {
  let query = Result.find(filter).sort({ createdAt: -1 });
  query = applyPopulate(query, RESULT_LIST_POPULATE);
  const [docs, total] = await Promise.all([
    query.skip(skip).limit(limit).lean(),
    Result.countDocuments(filter),
  ]);
  return { docs, total };
};

/** Détail complet d'un résultat non supprimé (lean, populate DETAIL). */
const findResultByIdPopulated = (id) =>
  applyPopulate(Result.findOne({ _id: id, isDeleted: false }), RESULT_DETAIL_POPULATE).lean();

/** Doc résultat non supprimé pour écriture (update / delete / workflow). */
const findResultForWrite = (id) => Result.findOne({ _id: id, isDeleted: false });

/** Doc résultat par id, session-aware (note originale d'un RETAKE en transaction). */
const findResultById = (id, { session } = {}) =>
  Result.findById(id).session(session ?? null);

/** Docs résultats pour écriture (publication par lot : besoin des hooks de save). */
const findResultsForWrite = (filter) => Result.find(filter);

// ─────────────────────────────────────────────────────────────────────────────
// RESULT — écritures
// ─────────────────────────────────────────────────────────────────────────────

/** Persiste un doc résultat (déclenche les hooks de save). `opts` : { session }. */
const saveResultDoc = (doc, opts) => doc.save(opts);

/** MAJ en masse de résultats (soumission/clôture par lot). */
const updateManyResults = (filter, update) => Result.updateMany(filter, update);

/** Écrit le score de risque de décrochage (atomique, fire-and-forget). */
const setDropoutRiskScore = (id, risk) =>
  Result.updateOne({ _id: id }, { $set: { dropoutRiskScore: risk } });

// ─────────────────────────────────────────────────────────────────────────────
// RESULT — statiques métier (logique de la couche model)
// ─────────────────────────────────────────────────────────────────────────────

/** Calcul du risque de décrochage d'un étudiant (statique du model). */
const computeDropoutRisk = (studentId, campusId) =>
  Result.computeDropoutRisk(studentId, campusId);

/** Distribution statistique d'une évaluation (statique du model). */
const getClassDistribution = (classId, subjectId, evaluationTitle, academicYear, semester) =>
  Result.getClassDistribution(classId, subjectId, evaluationTitle, academicYear, semester);

// ─────────────────────────────────────────────────────────────────────────────
// RESULT — agrégats (analytics / clôture)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Étudiants distincts d'un périmètre de clôture (génération des bulletins).
 * `matchStage` fourni casté par l'appelant.
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
 * Relevé de notes calculé à la volée (groupé par année/semestre/matière).
 * `matchFilter` fourni casté par l'appelant (student en ObjectId).
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
  ]);

/**
 * Vue analytique campus (facettes statut/type/période + stats générales).
 * `matchFilter` fourni par l'appelant. Renvoie le tableau brut d'agrégat.
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
// RESULT — listes spécialisées (controller)
// ─────────────────────────────────────────────────────────────────────────────

/** Liste de rattrapage (student/subject peuplés, tri score croissant). */
const listRetakeResults = (filter) =>
  Result.find(filter)
    .populate('student', 'firstName lastName matricule email')
    .populate('subject', 'subject_name subject_code coefficient')
    .select('student subject score maxScore normalizedScore gradeBand evaluationTitle evaluationType')
    .sort({ normalizedScore: 1 })
    .lean();

/** Résultat authentifiable par token QR (vérification publique, lean). */
const findResultByVerificationToken = (token) =>
  Result.findOne({ verificationToken: token, isDeleted: false })
    .populate('student', 'firstName lastName matricule')
    .populate('subject', 'subject_name subject_code')
    .populate('class',   'className')
    .select('student subject class academicYear semester evaluationType evaluationTitle ' +
            'normalizedScore gradeBand publishedAt status examPeriod')
    .lean();

// ─────────────────────────────────────────────────────────────────────────────
// RESULT — service inter-modules (compteurs / listes paginées / récents)
// ─────────────────────────────────────────────────────────────────────────────

/** Compteur de résultats (filtre composé par le service). */
const countResults = (filter) => Result.countDocuments(filter);

/** Liste paginée campus (staff/mentor readonly) : student/subject/class peuplés. */
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

/** Résultats PUBLISHED d'un étudiant (portail parent), virtuals inclus. */
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

/** Commentaires pédagogiques des résultats PUBLISHED d'un étudiant (parent). */
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

/** Dashboard étudiant : derniers résultats PUBLISHED (scores inclus). */
const findRecentResultsForStudent = (filter, limit) =>
  Result.find(filter)
    .select('evaluationTitle evaluationType academicYear semester normalizedScore score maxScore gradeBand publishedAt subject')
    .populate('subject', 'subject_name subject_code')
    .sort({ publishedAt: -1 })
    .limit(limit)
    .lean({ virtuals: true });

/** Dashboard parent : derniers résultats PUBLISHED d'un enfant. */
const findRecentResultsForChild = (filter, limit) =>
  Result.find(filter)
    .select('evaluationTitle evaluationType academicYear semester normalizedScore gradeBand publishedAt subject')
    .populate('subject', 'subject_name')
    .sort({ publishedAt: -1 })
    .limit(limit)
    .lean({ virtuals: true });

/** Dashboard mentor : derniers résultats PUBLISHED de ses étudiants. */
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

/** Génération d'un bulletin définitif d'étudiant (statique du model). */
const generateTranscriptForStudent = (params) =>
  FinalTranscript.generateForStudent(params);

/** Bulletin définitif stocké d'un étudiant (student/class peuplés, lean). */
const findTranscriptForStudentPopulated = ({ studentId, academicYear, semester }) =>
  FinalTranscript.findOne({ student: studentId, academicYear, semester })
    .populate('student', 'firstName lastName matricule email')
    .populate('class',   'className')
    .lean();

/** Doc bulletin par id pour écriture (validation / signature). */
const findTranscriptForWrite = (id) => FinalTranscript.findById(id);

/** Persiste un doc bulletin (déclenche les hooks de save). */
const saveTranscriptDoc = (doc) => doc.save();

/** Bulletins VALIDATED/SEALED d'un étudiant (portail parent, lean virtuals). */
const listStudentTranscripts = (filter) =>
  FinalTranscript.find(filter)
    .select('-__v')
    .populate('class',   'className level')
    .populate('student', 'firstName lastName profileImage')
    .sort({ academicYear: -1, semester: 1 })
    .lean({ virtuals: true });

/** Doc bulletin scopé étudiant/campus pour signature parent (écriture). */
const findTranscriptForSignature = ({ transcriptId, studentId, campusId }) =>
  FinalTranscript.findOne({
    _id:          transcriptId,
    student:      studentId,
    schoolCampus: campusId,
  });

/** Bulletin d'un étudiant pour impression PDF (academic-print, lean). */
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

/** Barèmes actifs d'un campus (tri défaut puis nom, lean). */
const listActiveGradingScales = (campusFilter) =>
  GradingScale.find({ isActive: true, ...campusFilter })
    .sort({ isDefault: -1, name: 1 })
    .lean();

/** Crée un barème (validation des bands en pre-save). */
const createGradingScale = (payload) => GradingScale.create(payload);

/** Doc barème par id pour écriture (mise à jour). */
const findGradingScaleForWrite = (id) => GradingScale.findById(id);

/** Persiste un doc barème (déclenche la validation pre-save des bands). */
const saveGradingScaleDoc = (doc) => doc.save();

module.exports = {
  // Result — transaction
  startSession,
  // Result — création
  createResult,
  insertManyResults,
  // Result — lectures
  paginateResults,
  findResultByIdPopulated,
  findResultForWrite,
  findResultById,
  findResultsForWrite,
  // Result — écritures
  saveResultDoc,
  updateManyResults,
  setDropoutRiskScore,
  // Result — statiques métier
  computeDropoutRisk,
  getClassDistribution,
  // Result — agrégats
  aggregateDistinctStudentsForLock,
  aggregateStudentTranscript,
  aggregateCampusOverview,
  // Result — listes spécialisées
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
