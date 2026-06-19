'use strict';

/**
 * @file exam.repository.js — data access layer of the exam module (SEMS).
 *
 * The ONLY file allowed to touch the 7 owned models:
 *   - ExamSession            (exam.session.model)
 *   - ExamEnrollment         (exam.enrollment.model)
 *   - ExamSubmission         (exam.submission.model)
 *   - ExamGrading            (exam.grading.model)
 *   - ExamAppeal             (exam.appeal.model)
 *   - QuestionBank           (question-bank.model)
 *   - ExamAnalyticsSnapshot  (exam.analytics-snapshot.model)
 *
 * Controllers (session / enrollment / delivery / grading / appeal / certificate /
 * question-bank / analytics), the inter-module service, the analytics worker, the
 * anti-cheat cron and the schedule-sync helper go exclusively through it — none of
 * these files imports a model anymore.
 *
 * Conventions:
 *   - List reads → `.lean()` (plain objects). Reads meant to be mutated then saved,
 *     or rendered via `.toObject()`, stay as hydrated documents
 *     (consumeHallTicket, save, virtuals…).
 *   - Hooked writes (validate/save) via load→mutate→save (saveXxxDoc) or
 *     atomic operators (findByIdAndUpdate/$set/$push/$inc, updateMany).
 *   - The aggregation pipelines (campus overview, early-warning, per-session
 *     stats) live HERE; the caller provides the `$match` already cast to
 *     ObjectId (cf. exam.helper.castForAggregation) as well as skip/limit/threshold.
 *   - The populate shapes (query shape) live HERE.
 *
 * Accepted exceptions (stay outside the repo):
 *   - Inter-module facades (subject/class/teacher/student/settings): called
 *     by the controllers, this is not the exam module's persistence access.
 *   - The consumeHallTicket() instance method: model-layer logic,
 *     invoked by the controller on the doc returned by the repo.
 *   - Status constants/enums: imported directly by the controllers.
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
// EXAM SESSION — reads
// ─────────────────────────────────────────────────────────────────────────────

/** Session document by arbitrary filter (status/transitions — non lean). */
const findSessionByFilter = (filter) => ExamSession.findOne(filter);

/** Session document by id (worker, delivery, appeal — non lean). */
const findSessionById = (id) => ExamSession.findById(id);

/** Session by id, `status` projection only. */
const findSessionStatusById = (id) => ExamSession.findById(id, 'status');

/** Session by id, `endTime` projection only (server timer). */
const findSessionEndTimeById = (id) => ExamSession.findById(id, 'endTime');

/** Session by id, student-summary projection (submission view). */
const findSessionSummaryById = (id) =>
  ExamSession.findById(id, 'title status maxScore subject startTime endTime');

/** Session by id, lean version (anti-cheat cron). */
const findSessionByIdLean = (id) => ExamSession.findById(id).lean();

/** Session detail (manager view) — non lean (output via .toObject()). */
const findSessionDetailed = (filter) =>
  ExamSession.findOne(filter)
    .populate('subject',      'subject_name subject_code')
    .populate('classes',      'className level')
    .populate('teacher',      'firstName lastName email')
    .populate('invigilators', 'firstName lastName email')
    .populate('gradingScale', 'name passMark')
    .populate({ path: 'questions.questionId', select: 'questionText questionType difficulty points' });

/** Session re-read and populated after a DRAFT update (lean). */
const findSessionByIdPopulatedLean = (id) =>
  ExamSession.findById(id)
    .populate('subject',      'subject_name subject_code')
    .populate('classes',      'className level')
    .populate('teacher',      'firstName lastName email')
    .populate('invigilators', 'firstName lastName email')
    .lean();

/** Session populated for hall-ticket generation (exam cards). */
const findSessionForHallTickets = (filter) =>
  ExamSession.findOne(filter)
    .populate('subject', 'subject_name')
    .populate('classes', 'name');

/** Session populated for injection into timetables (lean). */
const findSessionForScheduleInjection = (id) =>
  ExamSession.findById(id)
    .populate('subject', 'subject_name subject_code coefficient')
    .populate('teacher', 'firstName lastName email')
    .populate('classes', 'className name level')
    .lean();

/** Paginated list of sessions (manager view). */
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

/** Paginated list of a campus's sessions (inter-module facade, lean). */
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

/** Sessions populated for the report export (lean). */
const findSessionsForExport = (filter) =>
  ExamSession.find(filter)
    .populate('subject', 'subject_name')
    .populate('classes', 'name')
    .lean();

/** Recently COMPLETED sessions (anti-cheat cron, batch). */
const findRecentlyCompletedSessions = (since, limit) =>
  ExamSession.find({ status: 'COMPLETED', completedAt: { $gte: since }, isDeleted: false })
    .select('_id')
    .limit(limit)
    .lean();

/** Session ids by filter (early-warning, year isolation). */
const distinctSessionIds = (filter) => ExamSession.find(filter).distinct('_id');

/** Session count by filter. */
const countExamSessions = (filter) => ExamSession.countDocuments(filter);

// ─────────────────────────────────────────────────────────────────────────────
// EXAM SESSION — writes
// ─────────────────────────────────────────────────────────────────────────────

/** Creates a session (triggers the validation hooks). */
const createSession = (payload) => ExamSession.create(payload);

/** Updates a DRAFT session (with validators). */
const updateSessionById = (id, updates) =>
  ExamSession.findByIdAndUpdate(id, { $set: updates }, { runValidators: true });

/** Soft-delete of a DRAFT session. */
const softDeleteSession = (id, userId) =>
  ExamSession.findByIdAndUpdate(id, { isDeleted: true, updatedBy: userId });

/** Applies a state-machine transition (returns the updated doc). */
const applySessionTransition = (id, setFields) =>
  ExamSession.findByIdAndUpdate(id, { $set: setFields }, { new: true });

/** Sets a raw status on a session (DRAFT→ONGOING when a submission starts). */
const setSessionStatus = (id, status) =>
  ExamSession.findByIdAndUpdate(id, { status });

// ─────────────────────────────────────────────────────────────────────────────
// EXAM ENROLLMENT
// ─────────────────────────────────────────────────────────────────────────────

/** Enrollment by (session, student) — non lean (mutated then saved). */
const findEnrollment = (sessionId, studentId) =>
  ExamEnrollment.findOne({ examSession: sessionId, student: studentId, isDeleted: false });

/** Enrollment by id — non lean. */
const findEnrollmentById = (id) => ExamEnrollment.findOne({ _id: id, isDeleted: false });

/** Detailed enrollment (student + session→subject) — card/hall-ticket view. */
const findEnrollmentDetailed = (id) =>
  ExamEnrollment.findOne({ _id: id, isDeleted: false })
    .populate('student', 'firstName lastName matricule profileImage')
    .populate({ path: 'examSession', populate: { path: 'subject', select: 'subject_name' } });

/** Enrollment by hall ticket (QR check-in) — non lean. */
const findEnrollmentByHallTicket = (sessionId, token) =>
  ExamEnrollment.findOne({ examSession: sessionId, hallTicketToken: token, isDeleted: false })
    .populate('student', 'firstName lastName matricule');

/** Eligible enrollments of a session (bulk generation) — non lean. */
const findEligibleEnrollments = (sessionId) =>
  ExamEnrollment.find({ examSession: sessionId, isEligible: true, isDeleted: false })
    .populate('student', 'firstName lastName matricule profileImage');

/** Paginated list of enrollments (lean). */
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

/** Count of a session's enrollments. */
const countEnrollmentsForSession = (sessionId) =>
  ExamEnrollment.countDocuments({ examSession: sessionId, isDeleted: false });

/** Count of a session's absentees (analytics snapshot). */
const countAbsentEnrollments = (sessionId) =>
  ExamEnrollment.countDocuments({ examSession: sessionId, attendance: 'ABSENT', isDeleted: false });

/** A student's upcoming enrollments (dashboard facade) — lean. */
const findUpcomingEnrollmentsForStudent = (studentId) =>
  ExamEnrollment.find({ student: studentId, isEligible: true, isDeleted: false })
    .populate({
      path:     'examSession',
      match:    { status: { $in: ['SCHEDULED', 'PUBLISHED', 'ONGOING'] }, startTime: { $gte: new Date() }, isDeleted: false },
      select:   'title startTime endTime status room subject',
      populate: { path: 'subject', select: 'subject_name' },
    })
    .lean();

/** Creates an enrollment (hooks). */
const createEnrollment = (payload) => ExamEnrollment.create(payload);

/** Saves an enrollment doc (preserves hooks/setters). */
const saveEnrollmentDoc = (doc) => doc.save();

/** Updates an enrollment (manager override) — returns the populated doc. */
const updateEnrollmentById = (id, updates) =>
  ExamEnrollment.findByIdAndUpdate(id, { $set: updates }, { new: true })
    .populate('student', 'firstName lastName matricule');

/** Soft-delete of an enrollment. */
const softDeleteEnrollment = (id, userId) =>
  ExamEnrollment.findByIdAndUpdate(id, { isDeleted: true, updatedBy: userId });

// ─────────────────────────────────────────────────────────────────────────────
// EXAM SUBMISSION
// ─────────────────────────────────────────────────────────────────────────────

/** A student's submission for a session (start idempotency) — non lean. */
const findSubmissionForStudent = (sessionId, studentId) =>
  ExamSubmission.findOne({ examSession: sessionId, student: studentId, isDeleted: false });

/** Submission by id belonging to a student — non lean (mutated/.toObject()). */
const findSubmissionByIdForStudent = (id, studentId) =>
  ExamSubmission.findOne({ _id: id, student: studentId, isDeleted: false });

/** A student's IN_PROGRESS submission (save answer / anti-cheat) — non lean. */
const findActiveSubmission = (id, studentId) =>
  ExamSubmission.findOne({ _id: id, student: studentId, status: 'IN_PROGRESS', isDeleted: false });

/** Submission by id (staff/student submission view) — non lean (.toObject()). */
const findSubmissionByIdAny = (id) => ExamSubmission.findOne({ _id: id, isDeleted: false });

/** Submission by id, verifiable for grading (any non-deleted submission). */
const findSubmissionById = (id) => ExamSubmission.findOne({ _id: id, isDeleted: false });

/** Paginated list of submissions (grading queue) — lean. */
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

/** A session's submissions for the analytics snapshot — non lean. */
const findSubmissionsForSnapshot = (sessionId) =>
  ExamSubmission.find({ examSession: sessionId, status: { $in: ['SUBMITTED', 'GRADED'] }, isDeleted: false })
    .select('answers student');

/** A session's submissions for anti-cheat analysis — lean. */
const findSubmissionsForAntiCheat = (sessionId) =>
  ExamSubmission.find({ examSession: sessionId, status: { $in: ['SUBMITTED', 'GRADED'] }, isDeleted: false })
    .select('student answers antiCheatFlags')
    .lean();

/** Creates a submission (hooks). */
const createSubmission = (payload) => ExamSubmission.create(payload);

/** Saves a submission doc (preserves hooks/setters). */
const saveSubmissionDoc = (doc) => doc.save();

/** Sets a status on a submission. */
const setSubmissionStatus = (id, status) =>
  ExamSubmission.findByIdAndUpdate(id, { status });

/** Adds an anti-cheat flag (append-only). */
const pushAntiCheatFlag = (id, flag) =>
  ExamSubmission.findByIdAndUpdate(id, { $push: { antiCheatFlags: flag } });

// ─────────────────────────────────────────────────────────────────────────────
// EXAM GRADING
// ─────────────────────────────────────────────────────────────────────────────

/** Grading by id — non lean (mutated/saved). */
const findGradingById = (id) => ExamGrading.findOne({ _id: id, isDeleted: false });

/** Grading by filter (campus isolation) — populated detail. */
const findGradingDetailed = (filter) =>
  ExamGrading.findOne(filter)
    .populate('student',      'firstName lastName matricule')
    .populate('grader',       'firstName lastName')
    .populate('secondGrader', 'firstName lastName')
    .populate('submission',   'answers submittedAt status')
    .populate('examSession',  'title subject maxScore startTime');

/** Grading of a submission (non-deleted) — pre-existence before scoring. */
const findGradingBySubmission = (submissionId) =>
  ExamGrading.findOne({ submission: submissionId, isDeleted: false });

/** Grading of a submission without the isDeleted filter (idempotent MCQ auto-grading). */
const findGradingBySubmissionAny = (submissionId) =>
  ExamGrading.findOne({ submission: submissionId });

/** Grading populated for certificate generation/reissue — non lean. */
const findGradingForCertificate = (id) =>
  ExamGrading.findOne({ _id: id, isDeleted: false })
    .populate('student',     'firstName lastName matricule schoolCampus')
    .populate('examSession', 'title subject academicYear semester examPeriod startTime maxScore');

/** Grading by certificate token (public verification). */
const findGradingByCertificateToken = (token) =>
  ExamGrading.findOne({ certificateToken: token })
    .populate('student',     'firstName lastName matricule')
    .populate('examSession', 'title subject academicYear semester examPeriod startTime');

/** Paginated list of gradings (lean). */
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

/** Submissions already assigned to a grader for a session (teacher queue). */
const distinctGradedSubmissions = (sessionId, graderId) =>
  ExamGrading.find({ examSession: sessionId, grader: graderId }).distinct('submission');

/** Published gradings for a session used in the analytics snapshot — non-lean. */
const findPublishedGradingsForSnapshot = (sessionId) =>
  ExamGrading.find({ examSession: sessionId, status: 'PUBLISHED', isDeleted: false })
    .select('normalizedScore student examSession schoolCampus');

/** Creates a grading (hooks: normalizedScore, needsMediation…). */
const createGrading = (payload) => ExamGrading.create(payload);

/** Sauve un doc de correction (certificateToken…). */
const saveGradingDoc = (doc) => doc.save();

/**
 * Updates a grading by id. `opts` is passed as-is to findByIdAndUpdate
 * (callers choose new/runValidators depending on the case;
 * appeal score propagation passes `{}`, without validators).
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
 * Recipients of an upcoming publication: { student, schoolCampus } from
 * gradings still eligible for publishing (same criteria as publishSessionGradings).
 * Must be called BEFORE publishing to notify the affected students.
 */
const findSessionGradingRecipients = (sessionId) =>
  ExamGrading.find(
    { examSession: sessionId, status: { $in: ['GRADED', 'MEDIATED'] }, isDeleted: false },
    'student schoolCampus'
  ).lean();

/** Number of pending submissions for a grader (dashboard facade). */
const countPendingGradingForGrader = (graderId) =>
  ExamGrading.countDocuments({
    grader:    new mongoose.Types.ObjectId(graderId),
    status:    'PENDING',
    isDeleted: false,
  });

// ─────────────────────────────────────────────────────────────────────────────
// EXAM APPEAL
// ─────────────────────────────────────────────────────────────────────────────

/** Appeal by (grading, student) — duplicate guard. */
const findAppealByGradingAndStudent = (gradingId, studentId) =>
  ExamAppeal.findOne({ grading: gradingId, student: studentId, isDeleted: false });

/** Recours par filtre (isolation campus) — non lean (mutation review). */
const findAppealByFilter = (filter) => ExamAppeal.findOne(filter);

/** Paginated list of appeals (lean). */
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

/** Creates an appeal (hooks). */
const createAppeal = (payload) => ExamAppeal.create(payload);

/** Sauve un doc de recours (auto-reject deadline). */
const saveAppealDoc = (doc) => doc.save();

/** Updates an appeal (returns the updated doc). */
const updateAppealById = (id, setFields) =>
  ExamAppeal.findByIdAndUpdate(id, { $set: setFields }, { new: true });

/** Updates an appeal and returns the populated doc (resolution). */
const updateAppealByIdPopulated = (id, setFields) =>
  ExamAppeal.findByIdAndUpdate(id, { $set: setFields }, { new: true })
    .populate('student', 'firstName lastName')
    .populate('grading', 'normalizedScore finalScore');

// ─────────────────────────────────────────────────────────────────────────────
// QUESTION BANK
// ─────────────────────────────────────────────────────────────────────────────

/** Question par filtre (isolation campus) — non lean. */
const findQuestionByFilter = (filter) => QuestionBank.findOne(filter);

/** Detailed question (subject/course/createdBy populated). */
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

/** Paginated list of questions (lean). */
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

/** Questions served to a candidate (delivery) — non-lean (.toObject()). */
const findQuestionsForDelivery = (ids) =>
  QuestionBank.find({ _id: { $in: ids } })
    .select('questionText questionType options points difficulty bloomLevel language translations');

/** Questions MCQ par ids (auto-grading / snapshot) — projection au choix. */
const findMcqQuestionsByIds = (ids, select) =>
  QuestionBank.find({ _id: { $in: ids }, questionType: 'MCQ' }).select(select);

/** Creates a question (hooks). */
const createQuestion = (payload) => QuestionBank.create(payload);

/** Import en masse de questions (laisse passer les doublons). */
const insertManyQuestions = (docs) => QuestionBank.insertMany(docs, { ordered: false });

/** Updates a question (with validators). */
const updateQuestionById = (id, updates) =>
  QuestionBank.findByIdAndUpdate(id, { $set: updates }, { new: true, runValidators: true });

/** Soft-delete d'une question. */
const softDeleteQuestion = (id, userId) =>
  QuestionBank.findByIdAndUpdate(id, { isDeleted: true, updatedBy: userId });

/** Increments usage count for questions selected in a session. */
const incrementQuestionUsage = (ids) =>
  QuestionBank.updateMany(
    { _id: { $in: ids } },
    { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } }
  );

/** Sets the computed psychometric indices on a question (snapshot). */
const setQuestionPsychometrics = (id, { difficultyIndex, discriminationIdx }) =>
  QuestionBank.findByIdAndUpdate(id, { $set: { difficultyIndex, discriminationIdx } });

// ─────────────────────────────────────────────────────────────────────────────
// ANALYTICS SNAPSHOT
// ─────────────────────────────────────────────────────────────────────────────

/** Snapshot d'une session (item analysis). */
const findSnapshotBySession = (sessionId) =>
  ExamAnalyticsSnapshot.findOne({ examSession: sessionId });

/** Session snapshot, populated (detailed view). */
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
// AGGREGATES — the caller provides the $match already cast to ObjectId
// ─────────────────────────────────────────────────────────────────────────────

/** Global published grading stats for a campus (overview). */
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

/** Published grading stats aggregated per session (report export). */
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
  // ExamSession — writes
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
  // Aggregates
  aggregateCampusGradingStats,
  aggregateEarlyWarning,
  aggregateSessionGradingStats,
};
