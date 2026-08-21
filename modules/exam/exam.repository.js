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

const { notDeletedFilter, softDeletePatch } = require('../../shared/utils/soft-delete');

// Deletion fragments derived from each model rather than hard-coded (CLAUDE.md §5.1).
// Every exam collection carries an uppercase `status` workflow enum that includes
// 'ARCHIVED' — a live state. Only `isDeleted` marks a deletion here, and the two must not
// be confused; deriving the fragment removes the choice.
const SESSION_LIVE    = notDeletedFilter(ExamSession);
const ENROLLMENT_LIVE = notDeletedFilter(ExamEnrollment);
const SUBMISSION_LIVE = notDeletedFilter(ExamSubmission);
const GRADING_LIVE    = notDeletedFilter(ExamGrading);
const APPEAL_LIVE     = notDeletedFilter(ExamAppeal);

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

/**
 * COMPLETED sessions still awaiting an anti-cheat scan (cron, batch).
 *
 * Selects on the marker, not on a time window: `antiCheatScannedAt: null` is a fact, where
 * "completed in the last 48 h" was a proxy that disagreed with the job's own 24 h period and
 * scanned everything twice. Because a scanned session stops matching, the candidate set
 * DRAINS — a backlog larger than one batch is picked up on the following run rather than
 * sitting permanently behind the limit.
 *
 * Sorted oldest-first, which an unsorted `.limit()` was not: without a sort, which documents
 * the limit returns is unspecified, so the same sessions could be served every night while
 * others were never scanned at all.
 */
/**
 * Sessions awaiting an anti-cheat scan.
 *
 * @param {number} limit
 * @param {Object} [options]
 * @param {Array}  [options.excludeCampusIds] campuses whose Examinations module
 *   is not active (design doc §9.1). Excluded in the QUERY, not after the read:
 *   a batch filtered afterwards would return mostly rows the job may not touch
 *   and starve the campuses it may, while those sessions kept their null marker
 *   and re-filled the next batch identically.
 * @returns {Promise<Object[]>}
 */
const findSessionsPendingAntiCheat = (limit, { excludeCampusIds = [] } = {}) =>
  ExamSession.find({
    status: 'COMPLETED',
    antiCheatScannedAt: null,
    ...SESSION_LIVE,
    ...(excludeCampusIds.length ? { schoolCampus: { $nin: excludeCampusIds } } : {}),
  })
    .select('_id completedAt antiCheatScannedAt lastSubmissionAt')
    .sort({ completedAt: 1 })
    .limit(limit)
    .lean();

/**
 * How many sessions still await a scan (anti-cheat cron reporting).
 * The outstanding count, not the processed one: a job can only report what it did, and a
 * backlog is exactly what that number hides.
 */
const countSessionsPendingAntiCheat = ({ excludeCampusIds = [] } = {}) =>
  ExamSession.countDocuments({
    status: 'COMPLETED',
    antiCheatScannedAt: null,
    ...SESSION_LIVE,
    // Same exclusion as the batch above: a backlog figure that counted sessions
    // the job is not allowed to scan would grow forever and read as a failure.
    ...(excludeCampusIds.length ? { schoolCampus: { $nin: excludeCampusIds } } : {}),
  });

/** Stamps a session as scanned (anti-cheat cron). */
const markSessionAntiCheatScanned = (sessionId, at = new Date()) =>
  ExamSession.updateOne({ _id: sessionId }, { $set: { antiCheatScannedAt: at } });

/**
 * Records a submission arrival and invalidates any existing anti-cheat scan.
 *
 * Both fields move together, in one write, because they are one fact: a paper landed, so
 * whatever the last scan concluded was computed without it. `submitExam` gates on the
 * SUBMISSION's status rather than the session's, so this is reachable after COMPLETED.
 */
const noteSubmissionOnSession = (sessionId, at = new Date()) =>
  ExamSession.updateOne(
    { _id: sessionId },
    { $set: { lastSubmissionAt: at, antiCheatScannedAt: null } },
  );

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
  ExamSession.findByIdAndUpdate(id, { ...softDeletePatch(ExamSession), updatedBy: userId });

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
  ExamEnrollment.findOne({ examSession: sessionId, student: studentId, ...ENROLLMENT_LIVE });

/**
 * Enrollment by filter — non lean.
 * Callers pass `{ _id, ...campusFilter }` so campus isolation is always enforced.
 */
const findEnrollmentById = (filter) => ExamEnrollment.findOne({ ...filter, ...ENROLLMENT_LIVE });

/**
 * Detailed enrollment (student + session→subject) — card/hall-ticket view.
 * Callers pass `{ _id, ...campusFilter }` so campus isolation is always enforced.
 */
const findEnrollmentDetailed = (filter) =>
  ExamEnrollment.findOne({ ...filter, ...ENROLLMENT_LIVE })
    .populate('student', 'firstName lastName matricule profileImage')
    .populate({ path: 'examSession', populate: { path: 'subject', select: 'subject_name' } });

/** Enrollment by hall ticket (QR check-in) — non lean. */
const findEnrollmentByHallTicket = (sessionId, token) =>
  ExamEnrollment.findOne({ examSession: sessionId, hallTicketToken: token, ...ENROLLMENT_LIVE })
    .populate('student', 'firstName lastName matricule');

/** Eligible enrollments of a session (bulk generation) — non lean. */
const findEligibleEnrollments = (sessionId) =>
  ExamEnrollment.find({ examSession: sessionId, isEligible: true, ...ENROLLMENT_LIVE })
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
  ExamEnrollment.countDocuments({ examSession: sessionId, ...ENROLLMENT_LIVE });

/** Count of a session's absentees (analytics snapshot). */
const countAbsentEnrollments = (sessionId) =>
  ExamEnrollment.countDocuments({ examSession: sessionId, attendance: 'ABSENT', ...ENROLLMENT_LIVE });

/** Distinct session ids a student is enrolled in (student session scoping). */
const findEnrollmentSessionIdsForStudent = (studentId) =>
  ExamEnrollment.find({ student: studentId, ...ENROLLMENT_LIVE }).distinct('examSession');

/** A student's upcoming enrollments (dashboard facade) — lean. */
const findUpcomingEnrollmentsForStudent = (studentId) =>
  ExamEnrollment.find({ student: studentId, isEligible: true, ...ENROLLMENT_LIVE })
    .populate({
      path:     'examSession',
      // `match` applies to the populated ExamSession, not to the enrollment.
      match:    { status: { $in: ['SCHEDULED', 'PUBLISHED', 'ONGOING'] }, startTime: { $gte: new Date() }, ...SESSION_LIVE },
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
  ExamEnrollment.findByIdAndUpdate(id, { ...softDeletePatch(ExamEnrollment), updatedBy: userId });

// ─────────────────────────────────────────────────────────────────────────────
// EXAM SUBMISSION
// ─────────────────────────────────────────────────────────────────────────────

/** A student's submission for a session (start idempotency) — non lean. */
const findSubmissionForStudent = (sessionId, studentId) =>
  ExamSubmission.findOne({ examSession: sessionId, student: studentId, ...SUBMISSION_LIVE });

/** Submission by id belonging to a student — non lean (mutated/.toObject()). */
const findSubmissionByIdForStudent = (id, studentId) =>
  ExamSubmission.findOne({ _id: id, student: studentId, ...SUBMISSION_LIVE });

/** A student's IN_PROGRESS submission (save answer / anti-cheat) — non lean. */
const findActiveSubmission = (id, studentId) =>
  ExamSubmission.findOne({ _id: id, student: studentId, status: 'IN_PROGRESS', ...SUBMISSION_LIVE });

/**
 * Submission by filter (staff/student submission view) — non lean (.toObject()).
 * Callers pass `{ _id, ...campusFilter }` so campus isolation is always enforced.
 */
const findSubmissionByIdAny = (filter) => ExamSubmission.findOne({ ...filter, ...SUBMISSION_LIVE });

/** Submission by id, verifiable for grading (any non-deleted submission). */
const findSubmissionById = (id) => ExamSubmission.findOne({ _id: id, ...SUBMISSION_LIVE });

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
  ExamSubmission.find({ examSession: sessionId, status: { $in: ['SUBMITTED', 'GRADED'] }, ...SUBMISSION_LIVE })
    .select('answers student');

/** A session's submissions for anti-cheat analysis — lean. */
const findSubmissionsForAntiCheat = (sessionId) =>
  ExamSubmission.find({ examSession: sessionId, status: { $in: ['SUBMITTED', 'GRADED'] }, ...SUBMISSION_LIVE })
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

/**
 * Applies a whole scan's flags in one round trip (anti-cheat cron).
 *
 * The cron previously awaited two `findByIdAndUpdate` calls inside its O(n²) pairwise loop.
 * One write for the run also means the flags and the `antiCheatScannedAt` stamp can be
 * ordered deliberately: flags first, stamp second, so a run that dies between them re-scans
 * rather than marking a session scanned with half its findings missing.
 *
 * `ordered: false` — one rejected op must not discard the rest of the batch.
 */
const bulkPushAntiCheatFlags = (ops) =>
  (ops.length ? ExamSubmission.bulkWrite(ops, { ordered: false }) : Promise.resolve(null));

// ─────────────────────────────────────────────────────────────────────────────
// EXAM GRADING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grading by filter — non lean (mutated/saved).
 * Callers pass `{ _id, ...campusFilter }` so campus isolation is always enforced.
 */
const findGradingById = (filter) => ExamGrading.findOne({ ...filter, ...GRADING_LIVE });

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
  ExamGrading.findOne({ submission: submissionId, ...GRADING_LIVE });

/** Grading of a submission without the isDeleted filter (idempotent MCQ auto-grading). */
const findGradingBySubmissionAny = (submissionId) =>
  ExamGrading.findOne({ submission: submissionId });

/** Grading populated for certificate generation/reissue — non lean. */
const findGradingForCertificate = (id) =>
  ExamGrading.findOne({ _id: id, ...GRADING_LIVE })
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
      .populate({ path: 'examSession', select: 'title subject startTime', populate: { path: 'subject', select: 'subject_name' } })
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
  ExamGrading.find({ examSession: sessionId, status: 'PUBLISHED', ...GRADING_LIVE })
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
    { examSession: sessionId, status: { $in: ['GRADED', 'MEDIATED'] }, ...GRADING_LIVE },
    { $set: setFields }
  );

/**
 * Recipients of an upcoming publication: { student, schoolCampus } from
 * gradings still eligible for publishing (same criteria as publishSessionGradings).
 * Must be called BEFORE publishing to notify the affected students.
 */
const findSessionGradingRecipients = (sessionId) =>
  ExamGrading.find(
    { examSession: sessionId, status: { $in: ['GRADED', 'MEDIATED'] }, ...GRADING_LIVE },
    'student schoolCampus'
  ).lean();

/** Number of pending submissions for a grader (dashboard facade). */
const countPendingGradingForGrader = (graderId) =>
  ExamGrading.countDocuments({
    grader:    new mongoose.Types.ObjectId(graderId),
    status:    'PENDING',
    ...GRADING_LIVE,
  });

// ─────────────────────────────────────────────────────────────────────────────
// EXAM APPEAL
// ─────────────────────────────────────────────────────────────────────────────

/** Appeal by (grading, student) — duplicate guard. */
const findAppealByGradingAndStudent = (gradingId, studentId) =>
  ExamAppeal.findOne({ grading: gradingId, student: studentId, ...APPEAL_LIVE });

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
  QuestionBank.findByIdAndUpdate(id, { ...softDeletePatch(QuestionBank), updatedBy: userId });

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
    { $match: { examSession: { $in: sessionIds }, status: 'PUBLISHED', ...GRADING_LIVE } },
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
  findSessionsPendingAntiCheat,
  countSessionsPendingAntiCheat,
  markSessionAntiCheatScanned,
  noteSubmissionOnSession,
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
  findEnrollmentSessionIdsForStudent,
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
  bulkPushAntiCheatFlags,
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
