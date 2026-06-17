'use strict';

/**
 * @file exam.repository.js — couche d'accès aux données du module exam (SEMS).
 *
 * SEUL fichier autorisé à toucher les 7 models possédés :
 *   - ExamSession            (exam.session.model)
 *   - ExamEnrollment         (exam.enrollment.model)
 *   - ExamSubmission         (exam.submission.model)
 *   - ExamGrading            (exam.grading.model)
 *   - ExamAppeal             (exam.appeal.model)
 *   - QuestionBank           (question-bank.model)
 *   - ExamAnalyticsSnapshot  (exam.analytics-snapshot.model)
 *
 * Controllers (session / enrollment / delivery / grading / appeal / certificate /
 * question-bank / analytics), service inter-modules, worker d'analytics, cron
 * anti-triche et helper de synchro d'emploi du temps passent exclusivement par
 * lui — plus aucun de ces fichiers n'importe un model.
 *
 * Conventions :
 *   - Lectures de liste → `.lean()` (objets simples). Lectures destinées à être
 *     mutées puis sauvées, ou rendues via `.toObject()`, restent des documents
 *     hydratés (consumeHallTicket, save, virtuals…).
 *   - Écritures à hook (validate/save) via load→mutate→save (saveXxxDoc) ou
 *     opérateurs atomiques (findByIdAndUpdate/$set/$push/$inc, updateMany).
 *   - Les pipelines d'agrégation (overview campus, early-warning, stats par
 *     session) vivent ICI ; l'appelant fournit le `$match` déjà casté en
 *     ObjectId (cf. exam.helper.castForAggregation) ainsi que skip/limit/seuil.
 *   - Les formes de populate (query shape) vivent ICI.
 *
 * Exceptions assumées (restent hors repo) :
 *   - Façades inter-modules (subject/class/teacher/student/settings) : appelées
 *     par les controllers, ce n'est pas l'accès persistance du module exam.
 *   - Méthode d'instance consumeHallTicket() : logique de la couche model,
 *     invoquée par le controller sur le doc retourné par le repo.
 *   - Constantes/enums de statut : importées directement par les controllers.
 */

const mongoose = require('mongoose');

const ExamSession           = require('./models/exam.session.model');
const ExamEnrollment        = require('./models/exam.enrollment.model');
const ExamSubmission        = require('./models/exam.submission.model');
const ExamGrading           = require('./models/exam.grading.model');
const ExamAppeal            = require('./models/exam.appeal.model');
const QuestionBank          = require('./models/question-bank.model');
const ExamAnalyticsSnapshot = require('./models/exam.analytics-snapshot.model');

// ─────────────────────────────────────────────────────────────────────────────
// EXAM SESSION — lectures
// ─────────────────────────────────────────────────────────────────────────────

/** Document de session par filtre arbitraire (statut/transitions — non lean). */
const findSessionByFilter = (filter) => ExamSession.findOne(filter);

/** Document de session par id (worker, delivery, appeal — non lean). */
const findSessionById = (id) => ExamSession.findById(id);

/** Session par id, projection `status` seule. */
const findSessionStatusById = (id) => ExamSession.findById(id, 'status');

/** Session par id, projection `endTime` seule (timer serveur). */
const findSessionEndTimeById = (id) => ExamSession.findById(id, 'endTime');

/** Session par id, projection résumé étudiant (vue de copie). */
const findSessionSummaryById = (id) =>
  ExamSession.findById(id, 'title status maxScore subject startTime endTime');

/** Session par id, version lean (cron anti-triche). */
const findSessionByIdLean = (id) => ExamSession.findById(id).lean();

/** Détail d'une session (vue manager) — non lean (sortie via .toObject()). */
const findSessionDetailed = (filter) =>
  ExamSession.findOne(filter)
    .populate('subject',      'subject_name subject_code')
    .populate('classes',      'className level')
    .populate('teacher',      'firstName lastName email')
    .populate('invigilators', 'firstName lastName email')
    .populate('gradingScale', 'name passMark')
    .populate({ path: 'questions.questionId', select: 'questionText questionType difficulty points' });

/** Session re-lue et populée après update DRAFT (lean). */
const findSessionByIdPopulatedLean = (id) =>
  ExamSession.findById(id)
    .populate('subject',      'subject_name subject_code')
    .populate('classes',      'className level')
    .populate('teacher',      'firstName lastName email')
    .populate('invigilators', 'firstName lastName email')
    .lean();

/** Session populée pour la génération des cartes d'examen (hall tickets). */
const findSessionForHallTickets = (filter) =>
  ExamSession.findOne(filter)
    .populate('subject', 'subject_name')
    .populate('classes', 'name');

/** Session populée pour l'injection dans les emplois du temps (lean). */
const findSessionForScheduleInjection = (id) =>
  ExamSession.findById(id)
    .populate('subject', 'subject_name subject_code coefficient')
    .populate('teacher', 'firstName lastName email')
    .populate('classes', 'className name level')
    .lean();

/** Liste paginée des sessions (vue manager). */
const paginateSessions = async (match, { skip, limit }) => {
  const [docs, total] = await Promise.all([
    ExamSession.find(match)
      .select('-__v')
      .populate('subject', 'subject_name subject_code')
      .populate('classes', 'className level')
      .populate('teacher', 'firstName lastName')
      .sort({ startTime: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ExamSession.countDocuments(match),
  ]);
  return { docs, total };
};

/** Liste paginée des sessions d'un campus (façade inter-modules, lean). */
const paginateCampusExaminations = async (filter, { skip, limit }) => {
  const [docs, total] = await Promise.all([
    ExamSession.find(filter)
      .select('-__v')
      .sort({ startTime: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ExamSession.countDocuments(filter),
  ]);
  return { docs, total };
};

/** Sessions populées pour l'export rapport (lean). */
const findSessionsForExport = (filter) =>
  ExamSession.find(filter)
    .populate('subject', 'subject_name')
    .populate('classes', 'name')
    .lean();

/** Sessions COMPLETED récentes (cron anti-triche, batch). */
const findRecentlyCompletedSessions = (since, limit) =>
  ExamSession.find({ status: 'COMPLETED', completedAt: { $gte: since }, isDeleted: false })
    .select('_id')
    .limit(limit)
    .lean();

/** Ids de sessions par filtre (early-warning, isolation année). */
const distinctSessionIds = (filter) => ExamSession.find(filter).distinct('_id');

/** Compte de sessions par filtre. */
const countExamSessions = (filter) => ExamSession.countDocuments(filter);

// ─────────────────────────────────────────────────────────────────────────────
// EXAM SESSION — écritures
// ─────────────────────────────────────────────────────────────────────────────

/** Crée une session (déclenche les hooks de validation). */
const createSession = (payload) => ExamSession.create(payload);

/** Met à jour une session DRAFT (avec validateurs). */
const updateSessionById = (id, updates) =>
  ExamSession.findByIdAndUpdate(id, { $set: updates }, { runValidators: true });

/** Soft-delete d'une session DRAFT. */
const softDeleteSession = (id, userId) =>
  ExamSession.findByIdAndUpdate(id, { isDeleted: true, updatedBy: userId });

/** Applique une transition de la machine à états (renvoie le doc à jour). */
const applySessionTransition = (id, setFields) =>
  ExamSession.findByIdAndUpdate(id, { $set: setFields }, { new: true });

/** Pose un statut brut sur une session (DRAFT→ONGOING au démarrage de copie). */
const setSessionStatus = (id, status) =>
  ExamSession.findByIdAndUpdate(id, { status });

// ─────────────────────────────────────────────────────────────────────────────
// EXAM ENROLLMENT
// ─────────────────────────────────────────────────────────────────────────────

/** Inscription par (session, étudiant) — non lean (mutée puis sauvée). */
const findEnrollment = (sessionId, studentId) =>
  ExamEnrollment.findOne({ examSession: sessionId, student: studentId, isDeleted: false });

/** Inscription par id — non lean. */
const findEnrollmentById = (id) => ExamEnrollment.findOne({ _id: id, isDeleted: false });

/** Inscription détaillée (étudiant + session→subject) — vue carte/hall ticket. */
const findEnrollmentDetailed = (id) =>
  ExamEnrollment.findOne({ _id: id, isDeleted: false })
    .populate('student', 'firstName lastName matricule profileImage')
    .populate({ path: 'examSession', populate: { path: 'subject', select: 'subject_name' } });

/** Inscription par carte d'examen (check-in QR) — non lean. */
const findEnrollmentByHallTicket = (sessionId, token) =>
  ExamEnrollment.findOne({ examSession: sessionId, hallTicketToken: token, isDeleted: false })
    .populate('student', 'firstName lastName matricule');

/** Inscriptions éligibles d'une session (génération en masse) — non lean. */
const findEligibleEnrollments = (sessionId) =>
  ExamEnrollment.find({ examSession: sessionId, isEligible: true, isDeleted: false })
    .populate('student', 'firstName lastName matricule profileImage');

/** Liste paginée des inscriptions (lean). */
const paginateEnrollments = async (match, { skip, limit }) => {
  const [docs, total] = await Promise.all([
    ExamEnrollment.find(match)
      .populate('student', 'firstName lastName matricule profileImage')
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ExamEnrollment.countDocuments(match),
  ]);
  return { docs, total };
};

/** Compte des inscriptions d'une session. */
const countEnrollmentsForSession = (sessionId) =>
  ExamEnrollment.countDocuments({ examSession: sessionId, isDeleted: false });

/** Compte des absents d'une session (snapshot d'analytics). */
const countAbsentEnrollments = (sessionId) =>
  ExamEnrollment.countDocuments({ examSession: sessionId, attendance: 'ABSENT', isDeleted: false });

/** Inscriptions à venir d'un étudiant (façade dashboard) — lean. */
const findUpcomingEnrollmentsForStudent = (studentId) =>
  ExamEnrollment.find({ student: studentId, isEligible: true, isDeleted: false })
    .populate({
      path:     'examSession',
      match:    { status: { $in: ['SCHEDULED', 'PUBLISHED', 'ONGOING'] }, startTime: { $gte: new Date() }, isDeleted: false },
      select:   'title startTime endTime status room subject',
      populate: { path: 'subject', select: 'subject_name' },
    })
    .lean();

/** Crée une inscription (hooks). */
const createEnrollment = (payload) => ExamEnrollment.create(payload);

/** Sauve un doc d'inscription (préserve hooks/setters). */
const saveEnrollmentDoc = (doc) => doc.save();

/** Met à jour une inscription (override manager) — renvoie le doc populé. */
const updateEnrollmentById = (id, updates) =>
  ExamEnrollment.findByIdAndUpdate(id, { $set: updates }, { new: true })
    .populate('student', 'firstName lastName matricule');

/** Soft-delete d'une inscription. */
const softDeleteEnrollment = (id, userId) =>
  ExamEnrollment.findByIdAndUpdate(id, { isDeleted: true, updatedBy: userId });

// ─────────────────────────────────────────────────────────────────────────────
// EXAM SUBMISSION
// ─────────────────────────────────────────────────────────────────────────────

/** Copie d'un étudiant pour une session (idempotence de démarrage) — non lean. */
const findSubmissionForStudent = (sessionId, studentId) =>
  ExamSubmission.findOne({ examSession: sessionId, student: studentId, isDeleted: false });

/** Copie par id appartenant à un étudiant — non lean (mutée/.toObject()). */
const findSubmissionByIdForStudent = (id, studentId) =>
  ExamSubmission.findOne({ _id: id, student: studentId, isDeleted: false });

/** Copie IN_PROGRESS d'un étudiant (save answer / anti-cheat) — non lean. */
const findActiveSubmission = (id, studentId) =>
  ExamSubmission.findOne({ _id: id, student: studentId, status: 'IN_PROGRESS', isDeleted: false });

/** Copie par id (vue de copie staff/étudiant) — non lean (.toObject()). */
const findSubmissionByIdAny = (id) => ExamSubmission.findOne({ _id: id, isDeleted: false });

/** Copie par id, vérifiable pour correction (toute copie non supprimée). */
const findSubmissionById = (id) => ExamSubmission.findOne({ _id: id, isDeleted: false });

/** Liste paginée de copies (file de correction) — lean. */
const paginateSubmissions = async (match, { skip, limit }) => {
  const [docs, total] = await Promise.all([
    ExamSubmission.find(match)
      .populate('student', 'firstName lastName matricule')
      .sort({ submittedAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ExamSubmission.countDocuments(match),
  ]);
  return { docs, total };
};

/** Copies d'une session pour le snapshot d'analytics — non lean. */
const findSubmissionsForSnapshot = (sessionId) =>
  ExamSubmission.find({ examSession: sessionId, status: { $in: ['SUBMITTED', 'GRADED'] }, isDeleted: false })
    .select('answers student');

/** Copies d'une session pour l'analyse anti-triche — lean. */
const findSubmissionsForAntiCheat = (sessionId) =>
  ExamSubmission.find({ examSession: sessionId, status: { $in: ['SUBMITTED', 'GRADED'] }, isDeleted: false })
    .select('student answers antiCheatFlags')
    .lean();

/** Crée une copie (hooks). */
const createSubmission = (payload) => ExamSubmission.create(payload);

/** Sauve un doc de copie (préserve hooks/setters). */
const saveSubmissionDoc = (doc) => doc.save();

/** Pose un statut sur une copie. */
const setSubmissionStatus = (id, status) =>
  ExamSubmission.findByIdAndUpdate(id, { status });

/** Ajoute un flag anti-triche (append-only). */
const pushAntiCheatFlag = (id, flag) =>
  ExamSubmission.findByIdAndUpdate(id, { $push: { antiCheatFlags: flag } });

// ─────────────────────────────────────────────────────────────────────────────
// EXAM GRADING
// ─────────────────────────────────────────────────────────────────────────────

/** Correction par id — non lean (mutée/sauvée). */
const findGradingById = (id) => ExamGrading.findOne({ _id: id, isDeleted: false });

/** Correction par filtre (isolation campus) — détail populé. */
const findGradingDetailed = (filter) =>
  ExamGrading.findOne(filter)
    .populate('student',      'firstName lastName matricule')
    .populate('grader',       'firstName lastName')
    .populate('secondGrader', 'firstName lastName')
    .populate('submission',   'answers submittedAt status')
    .populate('examSession',  'title subject maxScore startTime');

/** Correction d'une copie (non supprimée) — pré-existence avant notation. */
const findGradingBySubmission = (submissionId) =>
  ExamGrading.findOne({ submission: submissionId, isDeleted: false });

/** Correction d'une copie sans filtre isDeleted (auto-grading MCQ idempotent). */
const findGradingBySubmissionAny = (submissionId) =>
  ExamGrading.findOne({ submission: submissionId });

/** Correction populée pour génération/réémission de certificat — non lean. */
const findGradingForCertificate = (id) =>
  ExamGrading.findOne({ _id: id, isDeleted: false })
    .populate('student',     'firstName lastName matricule schoolCampus')
    .populate('examSession', 'title subject academicYear semester examPeriod startTime maxScore');

/** Correction par jeton de certificat (vérification publique). */
const findGradingByCertificateToken = (token) =>
  ExamGrading.findOne({ certificateToken: token })
    .populate('student',     'firstName lastName matricule')
    .populate('examSession', 'title subject academicYear semester examPeriod startTime');

/** Liste paginée des corrections (lean). */
const paginateGradings = async (match, { skip, limit }) => {
  const [docs, total] = await Promise.all([
    ExamGrading.find(match)
      .populate('student',      'firstName lastName matricule')
      .populate('grader',       'firstName lastName')
      .populate('secondGrader', 'firstName lastName')
      .populate('examSession',  'title subject startTime')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ExamGrading.countDocuments(match),
  ]);
  return { docs, total };
};

/** Copies déjà assignées à un correcteur sur une session (file enseignant). */
const distinctGradedSubmissions = (sessionId, graderId) =>
  ExamGrading.find({ examSession: sessionId, grader: graderId }).distinct('submission');

/** Corrections publiées d'une session pour le snapshot d'analytics — non lean. */
const findPublishedGradingsForSnapshot = (sessionId) =>
  ExamGrading.find({ examSession: sessionId, status: 'PUBLISHED', isDeleted: false })
    .select('normalizedScore student examSession schoolCampus');

/** Crée une correction (hooks : normalizedScore, needsMediation…). */
const createGrading = (payload) => ExamGrading.create(payload);

/** Sauve un doc de correction (certificateToken…). */
const saveGradingDoc = (doc) => doc.save();

/**
 * Met à jour une correction par id. `opts` est passé tel quel à
 * findByIdAndUpdate (les appelants choisissent new/runValidators selon le cas ;
 * la propagation de score d'appel passe `{}`, sans validateurs).
 */
const updateGradingById = (id, setFields, opts = {}) =>
  ExamGrading.findByIdAndUpdate(id, { $set: setFields }, opts);

/** Publication en masse des corrections d'une session (renvoie le writeResult). */
const publishSessionGradings = (sessionId, setFields) =>
  ExamGrading.updateMany(
    { examSession: sessionId, status: { $in: ['GRADED', 'MEDIATED'] }, isDeleted: false },
    { $set: setFields }
  );

/**
 * Destinataires d'une publication à venir : { student, schoolCampus } des
 * corrections encore publiables (mêmes critères que publishSessionGradings).
 * À appeler AVANT la publication pour notifier les étudiants concernés.
 */
const findSessionGradingRecipients = (sessionId) =>
  ExamGrading.find(
    { examSession: sessionId, status: { $in: ['GRADED', 'MEDIATED'] }, isDeleted: false },
    'student schoolCampus'
  ).lean();

/** Nombre de copies en attente pour un correcteur (façade dashboard). */
const countPendingGradingForGrader = (graderId) =>
  ExamGrading.countDocuments({
    grader:    new mongoose.Types.ObjectId(graderId),
    status:    'PENDING',
    isDeleted: false,
  });

// ─────────────────────────────────────────────────────────────────────────────
// EXAM APPEAL
// ─────────────────────────────────────────────────────────────────────────────

/** Recours par (correction, étudiant) — anti-doublon. */
const findAppealByGradingAndStudent = (gradingId, studentId) =>
  ExamAppeal.findOne({ grading: gradingId, student: studentId, isDeleted: false });

/** Recours par filtre (isolation campus) — non lean (mutation review). */
const findAppealByFilter = (filter) => ExamAppeal.findOne(filter);

/** Liste paginée des recours (lean). */
const paginateAppeals = async (match, { skip, limit }) => {
  const [docs, total] = await Promise.all([
    ExamAppeal.find(match)
      .populate('student', 'firstName lastName matricule')
      .populate({ path: 'grading', select: 'normalizedScore finalScore status examSession' })
      .populate('reviewedBy', 'firstName lastName role')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ExamAppeal.countDocuments(match),
  ]);
  return { docs, total };
};

/** Crée un recours (hooks). */
const createAppeal = (payload) => ExamAppeal.create(payload);

/** Sauve un doc de recours (auto-reject deadline). */
const saveAppealDoc = (doc) => doc.save();

/** Met à jour un recours (renvoie le doc à jour). */
const updateAppealById = (id, setFields) =>
  ExamAppeal.findByIdAndUpdate(id, { $set: setFields }, { new: true });

/** Met à jour un recours et renvoie le doc populé (résolution). */
const updateAppealByIdPopulated = (id, setFields) =>
  ExamAppeal.findByIdAndUpdate(id, { $set: setFields }, { new: true })
    .populate('student', 'firstName lastName')
    .populate('grading', 'normalizedScore finalScore');

// ─────────────────────────────────────────────────────────────────────────────
// QUESTION BANK
// ─────────────────────────────────────────────────────────────────────────────

/** Question par filtre (isolation campus) — non lean. */
const findQuestionByFilter = (filter) => QuestionBank.findOne(filter);

/** Question détaillée (subject/course/createdBy populés). */
const findQuestionDetailed = (filter) =>
  QuestionBank.findOne(filter)
    .populate('subject',   'subject_name subject_code')
    .populate('course',    'name')
    .populate('createdBy', 'firstName lastName');

/** Question par filtre, projection stats. */
const findQuestionStats = (filter) =>
  QuestionBank.findOne(
    filter,
    'questionText usageCount lastUsedAt difficultyIndex discriminationIdx bloomLevel difficulty'
  );

/** Liste paginée des questions (lean). */
const paginateQuestions = async (match, { skip, limit }) => {
  const [docs, total] = await Promise.all([
    QuestionBank.find(match)
      .select('-__v')
      .populate('subject',   'subject_name subject_code')
      .populate('createdBy', 'firstName lastName')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    QuestionBank.countDocuments(match),
  ]);
  return { docs, total };
};

/** Questions servies à un candidat (passation) — non lean (.toObject()). */
const findQuestionsForDelivery = (ids) =>
  QuestionBank.find({ _id: { $in: ids } })
    .select('questionText questionType options points difficulty bloomLevel language translations');

/** Questions MCQ par ids (auto-grading / snapshot) — projection au choix. */
const findMcqQuestionsByIds = (ids, select) =>
  QuestionBank.find({ _id: { $in: ids }, questionType: 'MCQ' }).select(select);

/** Crée une question (hooks). */
const createQuestion = (payload) => QuestionBank.create(payload);

/** Import en masse de questions (laisse passer les doublons). */
const insertManyQuestions = (docs) => QuestionBank.insertMany(docs, { ordered: false });

/** Met à jour une question (avec validateurs). */
const updateQuestionById = (id, updates) =>
  QuestionBank.findByIdAndUpdate(id, { $set: updates }, { new: true, runValidators: true });

/** Soft-delete d'une question. */
const softDeleteQuestion = (id, userId) =>
  QuestionBank.findByIdAndUpdate(id, { isDeleted: true, updatedBy: userId });

/** Incrémente l'usage des questions sélectionnées dans une session. */
const incrementQuestionUsage = (ids) =>
  QuestionBank.updateMany(
    { _id: { $in: ids } },
    { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } }
  );

/** Pose les indices psychométriques calculés sur une question (snapshot). */
const setQuestionPsychometrics = (id, { difficultyIndex, discriminationIdx }) =>
  QuestionBank.findByIdAndUpdate(id, { $set: { difficultyIndex, discriminationIdx } });

// ─────────────────────────────────────────────────────────────────────────────
// ANALYTICS SNAPSHOT
// ─────────────────────────────────────────────────────────────────────────────

/** Snapshot d'une session (item analysis). */
const findSnapshotBySession = (sessionId) =>
  ExamAnalyticsSnapshot.findOne({ examSession: sessionId });

/** Snapshot d'une session, populé (vue détaillée). */
const findSnapshotBySessionPopulated = (sessionId) =>
  ExamAnalyticsSnapshot.findOne({ examSession: sessionId })
    .populate('examSession', 'title startTime endTime academicYear semester examPeriod');

/** Snapshots de plusieurs sessions (export) — lean. */
const findSnapshotsBySessionIds = (sessionIds) =>
  ExamAnalyticsSnapshot.find({ examSession: { $in: sessionIds } }).lean();

/** Compte des snapshots par filtre. */
const countAnalyticsSnapshots = (filter) => ExamAnalyticsSnapshot.countDocuments(filter);

/** Upsert d'un snapshot d'analytics (worker). */
const upsertAnalyticsSnapshot = (sessionId, fields) =>
  ExamAnalyticsSnapshot.findOneAndUpdate(
    { examSession: sessionId },
    { $set: fields },
    { upsert: true, new: true }
  );

// ─────────────────────────────────────────────────────────────────────────────
// AGRÉGATS — l'appelant fournit le $match déjà casté en ObjectId
// ─────────────────────────────────────────────────────────────────────────────

/** Stats globales des corrections publiées d'un campus (overview). */
const aggregateCampusGradingStats = (match) =>
  ExamGrading.aggregate([
    { $match: match },
    {
      $group: {
        _id:         null,
        totalGraded: { $sum: 1 },
        avgScore:    { $avg: '$normalizedScore' },
        passCount:   { $sum: { $cond: [{ $gte: ['$normalizedScore', 10] }, 1, 0] } },
        atRiskCount: { $sum: { $cond: [{ $lt:  ['$normalizedScore',  8] }, 1, 0] } },
      },
    },
  ]);

/**
 * Liste « early-warning » des étudiants à risque (score de décrochage).
 * @param {Object} match   filtre casté (status PUBLISHED, campus, sessions…)
 * @param {Object} opts    { skip, limit, threshold }
 */
const aggregateEarlyWarning = (match, { skip, limit, threshold }) =>
  ExamGrading.aggregate([
    { $match: match },
    {
      $group: {
        _id:       '$student',
        avgScore:  { $avg: '$normalizedScore' },
        examCount: { $sum: 1 },
        failCount: { $sum: { $cond: [{ $lt: ['$normalizedScore', 10] }, 1, 0] } },
      },
    },
    {
      $addFields: {
        failRate:         { $multiply: [{ $divide: ['$failCount', '$examCount'] }, 100] },
        dropoutRiskScore: {
          $min: [
            100,
            {
              $add: [
                { $multiply: [{ $divide: ['$failCount', '$examCount'] }, 60] },
                { $multiply: [{ $subtract: [10, { $min: ['$avgScore', 10] }] }, 4] },
              ],
            },
          ],
        },
      },
    },
    { $match: { dropoutRiskScore: { $gte: threshold } } },
    { $sort: { dropoutRiskScore: -1 } },
    { $skip: skip },
    { $limit: limit },
    {
      $lookup: {
        from:         'students',
        localField:   '_id',
        foreignField: '_id',
        as:           'student',
      },
    },
    { $unwind: { path: '$student', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        student:          { firstName: 1, lastName: 1, matricule: 1, profileImage: 1 },
        avgScore:         { $round: ['$avgScore', 2] },
        examCount:        1,
        failCount:        1,
        failRate:         { $round: ['$failRate', 1] },
        dropoutRiskScore: { $round: ['$dropoutRiskScore', 1] },
      },
    },
  ]);

/** Stats des corrections publiées agrégées par session (export rapport). */
const aggregateSessionGradingStats = (sessionIds) =>
  ExamGrading.aggregate([
    { $match: { examSession: { $in: sessionIds }, status: 'PUBLISHED', isDeleted: false } },
    {
      $group: {
        _id:         '$examSession',
        avgScore:    { $avg: '$normalizedScore' },
        passCount:   { $sum: { $cond: [{ $gte: ['$normalizedScore', 10] }, 1, 0] } },
        totalGraded: { $sum: 1 },
      },
    },
  ]);

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // ExamSession — lectures
  findSessionByFilter,
  findSessionById,
  findSessionStatusById,
  findSessionEndTimeById,
  findSessionSummaryById,
  findSessionByIdLean,
  findSessionDetailed,
  findSessionByIdPopulatedLean,
  findSessionForHallTickets,
  findSessionForScheduleInjection,
  paginateSessions,
  paginateCampusExaminations,
  findSessionsForExport,
  findRecentlyCompletedSessions,
  distinctSessionIds,
  countExamSessions,
  // ExamSession — écritures
  createSession,
  updateSessionById,
  softDeleteSession,
  applySessionTransition,
  setSessionStatus,
  // ExamEnrollment
  findEnrollment,
  findEnrollmentById,
  findEnrollmentDetailed,
  findEnrollmentByHallTicket,
  findEligibleEnrollments,
  paginateEnrollments,
  countEnrollmentsForSession,
  countAbsentEnrollments,
  findUpcomingEnrollmentsForStudent,
  createEnrollment,
  saveEnrollmentDoc,
  updateEnrollmentById,
  softDeleteEnrollment,
  // ExamSubmission
  findSubmissionForStudent,
  findSubmissionByIdForStudent,
  findActiveSubmission,
  findSubmissionByIdAny,
  findSubmissionById,
  paginateSubmissions,
  findSubmissionsForSnapshot,
  findSubmissionsForAntiCheat,
  createSubmission,
  saveSubmissionDoc,
  setSubmissionStatus,
  pushAntiCheatFlag,
  // ExamGrading
  findGradingById,
  findGradingDetailed,
  findGradingBySubmission,
  findGradingBySubmissionAny,
  findGradingForCertificate,
  findGradingByCertificateToken,
  paginateGradings,
  distinctGradedSubmissions,
  findPublishedGradingsForSnapshot,
  createGrading,
  saveGradingDoc,
  updateGradingById,
  publishSessionGradings,
  findSessionGradingRecipients,
  countPendingGradingForGrader,
  // ExamAppeal
  findAppealByGradingAndStudent,
  findAppealByFilter,
  paginateAppeals,
  createAppeal,
  saveAppealDoc,
  updateAppealById,
  updateAppealByIdPopulated,
  // QuestionBank
  findQuestionByFilter,
  findQuestionDetailed,
  findQuestionStats,
  paginateQuestions,
  findQuestionsForDelivery,
  findMcqQuestionsByIds,
  createQuestion,
  insertManyQuestions,
  updateQuestionById,
  softDeleteQuestion,
  incrementQuestionUsage,
  setQuestionPsychometrics,
  // AnalyticsSnapshot
  findSnapshotBySession,
  findSnapshotBySessionPopulated,
  findSnapshotsBySessionIds,
  countAnalyticsSnapshots,
  upsertAnalyticsSnapshot,
  // Agrégats
  aggregateCampusGradingStats,
  aggregateEarlyWarning,
  aggregateSessionGradingStats,
};
