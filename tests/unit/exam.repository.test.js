'use strict';

/**
 * Couche repository — module exam / SEMS (R3, cœur académique ; 7 models).
 * Models mockés (sans DB) : ExamSession, ExamEnrollment, ExamSubmission,
 * ExamGrading, ExamAppeal, QuestionBank, ExamAnalyticsSnapshot.
 *
 * jest.mock impose des chemins littéraux + une factory auto-suffisante (hoisting :
 * buildModelMock est une déclaration de fonction, donc hissée). Chaque model est
 * un constructeur doté de statiques jest.fn ; les queries sont chaînables
 * (select/sort/skip/limit/populate) et .lean/.exec/.distinct/.then résolvent
 * __setLean.
 *
 * Accent mis sur les agrégats (non-régression des sorties overview campus /
 * early-warning / stats par session) et les formes de requête sensibles
 * (filtres de copies, upsert de snapshot, $push de flag anti-triche, populate
 * de carte d'examen / certificat, cast ObjectId du compteur de correction).
 */

const buildModelMock = () => {
  let leanVal = null;
  const makeQuery = () => {
    const q = {};
    ['select', 'sort', 'skip', 'limit', 'populate'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.lean = jest.fn(() => Promise.resolve(leanVal));
    q.exec = jest.fn(() => Promise.resolve(leanVal));
    q.distinct = jest.fn(() => Promise.resolve(leanVal || []));
    q.then = (resolve) => Promise.resolve(leanVal).then(resolve);
    return q;
  };
  function Model(data) { Object.assign(this, data); this._id = this._id || 'gen-id'; }
  Model.prototype.save = jest.fn(function save() { return Promise.resolve(this); });
  ['find', 'findOne', 'findById', 'findByIdAndUpdate', 'findOneAndUpdate', 'updateMany'].forEach((m) => {
    Model[m] = jest.fn(() => makeQuery());
  });
  Model.countDocuments = jest.fn(() => makeQuery());
  Model.aggregate = jest.fn(() => Promise.resolve([]));
  Model.create = jest.fn((d) => Promise.resolve({ _id: 'created', ...d }));
  Model.insertMany = jest.fn((docs) => Promise.resolve(docs));
  Model.__setLean = (v) => { leanVal = v; };
  return Model;
};

jest.mock('../../modules/exam/models/exam.session.model',            () => buildModelMock());
jest.mock('../../modules/exam/models/exam.enrollment.model',         () => buildModelMock());
jest.mock('../../modules/exam/models/exam.submission.model',         () => buildModelMock());
jest.mock('../../modules/exam/models/exam.grading.model',            () => buildModelMock());
jest.mock('../../modules/exam/models/exam.appeal.model',             () => buildModelMock());
jest.mock('../../modules/exam/models/question-bank.model',           () => buildModelMock());
jest.mock('../../modules/exam/models/exam.analytics-snapshot.model', () => buildModelMock());

const ExamSession           = require('../../modules/exam/models/exam.session.model');
const ExamEnrollment        = require('../../modules/exam/models/exam.enrollment.model');
const ExamSubmission        = require('../../modules/exam/models/exam.submission.model');
const ExamGrading           = require('../../modules/exam/models/exam.grading.model');
const ExamAppeal            = require('../../modules/exam/models/exam.appeal.model');
const QuestionBank          = require('../../modules/exam/models/question-bank.model');
const ExamAnalyticsSnapshot = require('../../modules/exam/models/exam.analytics-snapshot.model');
const repo = require('../../modules/exam/exam.repository');

const ALL = [ExamSession, ExamEnrollment, ExamSubmission, ExamGrading, ExamAppeal, QuestionBank, ExamAnalyticsSnapshot];

beforeEach(() => {
  jest.clearAllMocks();
  ALL.forEach((M) => M.__setLean(null));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('exam — ExamSession lectures', () => {
  test('findSessionByFilter : findOne avec le filtre brut', () => {
    repo.findSessionByFilter({ _id: 's1', isDeleted: false });
    expect(ExamSession.findOne).toHaveBeenCalledWith({ _id: 's1', isDeleted: false });
  });

  test('findSessionStatusById : projection status seule', () => {
    repo.findSessionStatusById('s1');
    expect(ExamSession.findById).toHaveBeenCalledWith('s1', 'status');
  });

  test('findSessionEndTimeById : projection endTime seule', () => {
    repo.findSessionEndTimeById('s1');
    expect(ExamSession.findById).toHaveBeenCalledWith('s1', 'endTime');
  });

  test('findSessionSummaryById : projection résumé étudiant', () => {
    repo.findSessionSummaryById('s1');
    expect(ExamSession.findById).toHaveBeenCalledWith('s1', 'title status maxScore subject startTime endTime');
  });

  test('findRecentlyCompletedSessions : COMPLETED depuis `since`, _id only, limit', () => {
    const since = new Date('2026-06-01');
    const q = ExamSession.find();
    ExamSession.find.mockClear();
    ExamSession.find.mockReturnValue(q);
    repo.findRecentlyCompletedSessions(since, 50);
    expect(ExamSession.find).toHaveBeenCalledWith({ status: 'COMPLETED', completedAt: { $gte: since }, isDeleted: false });
    expect(q.select).toHaveBeenCalledWith('_id');
    expect(q.limit).toHaveBeenCalledWith(50);
  });

  test('paginateSessions : find paginé + countDocuments, tri startTime asc', async () => {
    ExamSession.__setLean([{ _id: 's1' }]);
    ExamSession.countDocuments.mockReturnValueOnce(Promise.resolve(3));
    const out = await repo.paginateSessions({ isDeleted: false }, { skip: 0, limit: 10 });
    expect(out).toEqual({ docs: [{ _id: 's1' }], total: 3 });
  });

  test('distinctSessionIds : find(filter).distinct(_id)', async () => {
    ExamSession.__setLean(['a', 'b']);
    const ids = await repo.distinctSessionIds({ academicYear: '2025-2026' });
    expect(ExamSession.find).toHaveBeenCalledWith({ academicYear: '2025-2026' });
    expect(ids).toEqual(['a', 'b']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('exam — ExamSession écritures', () => {
  test('createSession : create avec le payload', () => {
    repo.createSession({ title: 'X' });
    expect(ExamSession.create).toHaveBeenCalledWith({ title: 'X' });
  });

  test('updateSessionById : $set avec runValidators (DRAFT only)', () => {
    repo.updateSessionById('s1', { title: 'Y' });
    expect(ExamSession.findByIdAndUpdate).toHaveBeenCalledWith('s1', { $set: { title: 'Y' } }, { runValidators: true });
  });

  test('softDeleteSession : isDeleted + updatedBy', () => {
    repo.softDeleteSession('s1', 'u1');
    expect(ExamSession.findByIdAndUpdate).toHaveBeenCalledWith('s1', { isDeleted: true, updatedBy: 'u1' });
  });

  test('applySessionTransition : $set + new:true', () => {
    repo.applySessionTransition('s1', { status: 'ONGOING' });
    expect(ExamSession.findByIdAndUpdate).toHaveBeenCalledWith('s1', { $set: { status: 'ONGOING' } }, { new: true });
  });

  test('setSessionStatus : pose un statut brut', () => {
    repo.setSessionStatus('s1', 'ONGOING');
    expect(ExamSession.findByIdAndUpdate).toHaveBeenCalledWith('s1', { status: 'ONGOING' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('exam — ExamEnrollment', () => {
  test('findEnrollment : (session, étudiant), non supprimée', () => {
    repo.findEnrollment('s1', 'st1');
    expect(ExamEnrollment.findOne).toHaveBeenCalledWith({ examSession: 's1', student: 'st1', isDeleted: false });
  });

  test('findEnrollmentByHallTicket : par jeton de carte, populate student', () => {
    const q = ExamEnrollment.findOne();
    ExamEnrollment.findOne.mockClear();
    ExamEnrollment.findOne.mockReturnValue(q);
    repo.findEnrollmentByHallTicket('s1', 'tok');
    expect(ExamEnrollment.findOne).toHaveBeenCalledWith({ examSession: 's1', hallTicketToken: 'tok', isDeleted: false });
    expect(q.populate).toHaveBeenCalledWith('student', 'firstName lastName matricule');
  });

  test('countAbsentEnrollments : attendance ABSENT', () => {
    repo.countAbsentEnrollments('s1');
    expect(ExamEnrollment.countDocuments).toHaveBeenCalledWith({ examSession: 's1', attendance: 'ABSENT', isDeleted: false });
  });

  test('findUpcomingEnrollmentsForStudent : populate examSession avec match statut+futur', () => {
    const q = ExamEnrollment.find();
    ExamEnrollment.find.mockClear();
    ExamEnrollment.find.mockReturnValue(q);
    repo.findUpcomingEnrollmentsForStudent('st1');
    expect(ExamEnrollment.find).toHaveBeenCalledWith({ student: 'st1', isEligible: true, isDeleted: false });
    const [popArg] = q.populate.mock.calls[0];
    expect(popArg.path).toBe('examSession');
    expect(popArg.match.status).toEqual({ $in: ['SCHEDULED', 'PUBLISHED', 'ONGOING'] });
    expect(popArg.match.startTime.$gte).toBeInstanceOf(Date);
    expect(popArg.populate).toEqual({ path: 'subject', select: 'subject_name' });
  });

  test('updateEnrollmentById : $set + new:true + populate student', () => {
    const q = ExamEnrollment.findByIdAndUpdate();
    ExamEnrollment.findByIdAndUpdate.mockClear();
    ExamEnrollment.findByIdAndUpdate.mockReturnValue(q);
    repo.updateEnrollmentById('e1', { seatNumber: 12 });
    expect(ExamEnrollment.findByIdAndUpdate).toHaveBeenCalledWith('e1', { $set: { seatNumber: 12 } }, { new: true });
    expect(q.populate).toHaveBeenCalledWith('student', 'firstName lastName matricule');
  });

  test('saveEnrollmentDoc : délègue à doc.save', () => {
    const save = jest.fn(() => Promise.resolve());
    repo.saveEnrollmentDoc({ save });
    expect(save).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('exam — ExamSubmission', () => {
  test('findActiveSubmission : IN_PROGRESS de l\'étudiant', () => {
    repo.findActiveSubmission('sub1', 'st1');
    expect(ExamSubmission.findOne).toHaveBeenCalledWith({ _id: 'sub1', student: 'st1', status: 'IN_PROGRESS', isDeleted: false });
  });

  test('findSubmissionsForSnapshot : SUBMITTED/GRADED, projection answers+student', () => {
    const q = ExamSubmission.find();
    ExamSubmission.find.mockClear();
    ExamSubmission.find.mockReturnValue(q);
    repo.findSubmissionsForSnapshot('s1');
    expect(ExamSubmission.find).toHaveBeenCalledWith({ examSession: 's1', status: { $in: ['SUBMITTED', 'GRADED'] }, isDeleted: false });
    expect(q.select).toHaveBeenCalledWith('answers student');
  });

  test('findSubmissionsForAntiCheat : lean + projection student/answers/flags', () => {
    const q = ExamSubmission.find();
    ExamSubmission.find.mockClear();
    ExamSubmission.find.mockReturnValue(q);
    repo.findSubmissionsForAntiCheat('s1');
    expect(q.select).toHaveBeenCalledWith('student answers antiCheatFlags');
    expect(q.lean).toHaveBeenCalled();
  });

  test('pushAntiCheatFlag : $push append-only', () => {
    const flag = { event: 'SIMILARITY_FLAG' };
    repo.pushAntiCheatFlag('sub1', flag);
    expect(ExamSubmission.findByIdAndUpdate).toHaveBeenCalledWith('sub1', { $push: { antiCheatFlags: flag } });
  });

  test('setSubmissionStatus : pose un statut', () => {
    repo.setSubmissionStatus('sub1', 'GRADED');
    expect(ExamSubmission.findByIdAndUpdate).toHaveBeenCalledWith('sub1', { status: 'GRADED' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('exam — ExamGrading', () => {
  test('findGradingBySubmission : non supprimée', () => {
    repo.findGradingBySubmission('sub1');
    expect(ExamGrading.findOne).toHaveBeenCalledWith({ submission: 'sub1', isDeleted: false });
  });

  test('findGradingBySubmissionAny : sans filtre isDeleted (auto-grade idempotent)', () => {
    repo.findGradingBySubmissionAny('sub1');
    expect(ExamGrading.findOne).toHaveBeenCalledWith({ submission: 'sub1' });
  });

  test('distinctGradedSubmissions : find(session, grader).distinct(submission)', async () => {
    ExamGrading.__setLean(['sub1', 'sub2']);
    const out = await repo.distinctGradedSubmissions('s1', 'g1');
    expect(ExamGrading.find).toHaveBeenCalledWith({ examSession: 's1', grader: 'g1' });
    expect(out).toEqual(['sub1', 'sub2']);
  });

  test('findPublishedGradingsForSnapshot : PUBLISHED, projection scores/refs', () => {
    const q = ExamGrading.find();
    ExamGrading.find.mockClear();
    ExamGrading.find.mockReturnValue(q);
    repo.findPublishedGradingsForSnapshot('s1');
    expect(ExamGrading.find).toHaveBeenCalledWith({ examSession: 's1', status: 'PUBLISHED', isDeleted: false });
    expect(q.select).toHaveBeenCalledWith('normalizedScore student examSession schoolCampus');
  });

  test('updateGradingById : $set, opts transmis tels quels', () => {
    repo.updateGradingById('g1', { score: 15 }, { new: true, runValidators: true });
    expect(ExamGrading.findByIdAndUpdate).toHaveBeenCalledWith('g1', { $set: { score: 15 } }, { new: true, runValidators: true });
  });

  test('updateGradingById : opts par défaut {} (propagation de score d\'appel, sans validateurs)', () => {
    repo.updateGradingById('g1', { finalScore: 18 });
    expect(ExamGrading.findByIdAndUpdate).toHaveBeenCalledWith('g1', { $set: { finalScore: 18 } }, {});
  });

  test('publishSessionGradings : updateMany GRADED/MEDIATED → $set', () => {
    repo.publishSessionGradings('s1', { status: 'PUBLISHED' });
    expect(ExamGrading.updateMany).toHaveBeenCalledWith(
      { examSession: 's1', status: { $in: ['GRADED', 'MEDIATED'] }, isDeleted: false },
      { $set: { status: 'PUBLISHED' } }
    );
  });

  test('findSessionGradingRecipients : GRADED/MEDIATED, projection student/campus, lean', async () => {
    ExamGrading.__setLean([{ student: 'st1', schoolCampus: 'c1' }]);
    const out = await repo.findSessionGradingRecipients('s1');
    expect(ExamGrading.find).toHaveBeenCalledWith(
      { examSession: 's1', status: { $in: ['GRADED', 'MEDIATED'] }, isDeleted: false },
      'student schoolCampus'
    );
    expect(out).toEqual([{ student: 'st1', schoolCampus: 'c1' }]);
  });

  test('countPendingGradingForGrader : cast ObjectId + PENDING', () => {
    const oid = '5f9d88b9c1d2a30017e8b123';
    repo.countPendingGradingForGrader(oid);
    const arg = ExamGrading.countDocuments.mock.calls[0][0];
    expect(arg.status).toBe('PENDING');
    expect(arg.isDeleted).toBe(false);
    expect(String(arg.grader)).toBe(oid);
  });

  test('findGradingByCertificateToken : par jeton + populate student/session', () => {
    const q = ExamGrading.findOne();
    ExamGrading.findOne.mockClear();
    ExamGrading.findOne.mockReturnValue(q);
    repo.findGradingByCertificateToken('tok');
    expect(ExamGrading.findOne).toHaveBeenCalledWith({ certificateToken: 'tok' });
    expect(q.populate).toHaveBeenCalledWith('student', 'firstName lastName matricule');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('exam — ExamAppeal', () => {
  test('findAppealByGradingAndStudent : anti-doublon', () => {
    repo.findAppealByGradingAndStudent('g1', 'st1');
    expect(ExamAppeal.findOne).toHaveBeenCalledWith({ grading: 'g1', student: 'st1', isDeleted: false });
  });

  test('updateAppealById : $set + new:true', () => {
    repo.updateAppealById('a1', { status: 'UNDER_REVIEW' });
    expect(ExamAppeal.findByIdAndUpdate).toHaveBeenCalledWith('a1', { $set: { status: 'UNDER_REVIEW' } }, { new: true });
  });

  test('updateAppealByIdPopulated : $set + populate student/grading', () => {
    const q = ExamAppeal.findByIdAndUpdate();
    ExamAppeal.findByIdAndUpdate.mockClear();
    ExamAppeal.findByIdAndUpdate.mockReturnValue(q);
    repo.updateAppealByIdPopulated('a1', { status: 'RESOLVED' });
    expect(ExamAppeal.findByIdAndUpdate).toHaveBeenCalledWith('a1', { $set: { status: 'RESOLVED' } }, { new: true });
    expect(q.populate).toHaveBeenCalledWith('grading', 'normalizedScore finalScore');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('exam — QuestionBank', () => {
  test('findQuestionsForDelivery : projection passation (sans isCorrect implicite)', () => {
    const q = QuestionBank.find();
    QuestionBank.find.mockClear();
    QuestionBank.find.mockReturnValue(q);
    repo.findQuestionsForDelivery(['q1', 'q2']);
    expect(QuestionBank.find).toHaveBeenCalledWith({ _id: { $in: ['q1', 'q2'] } });
    expect(q.select).toHaveBeenCalledWith('questionText questionType options points difficulty bloomLevel language translations');
  });

  test('findMcqQuestionsByIds : filtre MCQ + select au choix de l\'appelant', () => {
    const q = QuestionBank.find();
    QuestionBank.find.mockClear();
    QuestionBank.find.mockReturnValue(q);
    repo.findMcqQuestionsByIds(['q1'], '_id options');
    expect(QuestionBank.find).toHaveBeenCalledWith({ _id: { $in: ['q1'] }, questionType: 'MCQ' });
    expect(q.select).toHaveBeenCalledWith('_id options');
  });

  test('insertManyQuestions : ordered:false (laisse passer les doublons)', () => {
    repo.insertManyQuestions([{ q: 1 }]);
    expect(QuestionBank.insertMany).toHaveBeenCalledWith([{ q: 1 }], { ordered: false });
  });

  test('incrementQuestionUsage : $inc usageCount + $set lastUsedAt', () => {
    repo.incrementQuestionUsage(['q1', 'q2']);
    const [filter, update] = QuestionBank.updateMany.mock.calls[0];
    expect(filter).toEqual({ _id: { $in: ['q1', 'q2'] } });
    expect(update.$inc).toEqual({ usageCount: 1 });
    expect(update.$set.lastUsedAt).toBeInstanceOf(Date);
  });

  test('setQuestionPsychometrics : $set difficultyIndex/discriminationIdx', () => {
    repo.setQuestionPsychometrics('q1', { difficultyIndex: 0.6, discriminationIdx: 0.3 });
    expect(QuestionBank.findByIdAndUpdate).toHaveBeenCalledWith('q1', { $set: { difficultyIndex: 0.6, discriminationIdx: 0.3 } });
  });

  test('findQuestionStats : findOne(filtre, projection stats)', () => {
    repo.findQuestionStats({ _id: 'q1', isDeleted: false });
    expect(QuestionBank.findOne).toHaveBeenCalledWith(
      { _id: 'q1', isDeleted: false },
      'questionText usageCount lastUsedAt difficultyIndex discriminationIdx bloomLevel difficulty'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('exam — AnalyticsSnapshot', () => {
  test('upsertAnalyticsSnapshot : findOneAndUpdate upsert+new', () => {
    repo.upsertAnalyticsSnapshot('s1', { mean: 12 });
    expect(ExamAnalyticsSnapshot.findOneAndUpdate).toHaveBeenCalledWith(
      { examSession: 's1' },
      { $set: { mean: 12 } },
      { upsert: true, new: true }
    );
  });

  test('findSnapshotsBySessionIds : $in + lean', () => {
    const q = ExamAnalyticsSnapshot.find();
    ExamAnalyticsSnapshot.find.mockClear();
    ExamAnalyticsSnapshot.find.mockReturnValue(q);
    repo.findSnapshotsBySessionIds(['s1', 's2']);
    expect(ExamAnalyticsSnapshot.find).toHaveBeenCalledWith({ examSession: { $in: ['s1', 's2'] } });
    expect(q.lean).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('exam — agrégats (non-régression)', () => {
  test('aggregateCampusGradingStats : $match fourni + $group taux réussite/à risque', () => {
    const match = { schoolCampus: 'c1', status: 'PUBLISHED', isDeleted: false };
    repo.aggregateCampusGradingStats(match);
    const [pipeline] = ExamGrading.aggregate.mock.calls[0];
    expect(pipeline[0]).toEqual({ $match: match });
    const grp = pipeline[1].$group;
    expect(grp._id).toBeNull();
    expect(grp.avgScore).toEqual({ $avg: '$normalizedScore' });
    expect(grp.passCount).toEqual({ $sum: { $cond: [{ $gte: ['$normalizedScore', 10] }, 1, 0] } });
    expect(grp.atRiskCount).toEqual({ $sum: { $cond: [{ $lt: ['$normalizedScore', 8] }, 1, 0] } });
  });

  test('aggregateEarlyWarning : groupe par étudiant, score de décrochage, seuil/skip/limit, lookup students', () => {
    const match = { schoolCampus: 'c1', status: 'PUBLISHED', isDeleted: false };
    repo.aggregateEarlyWarning(match, { skip: 10, limit: 20, threshold: 50 });
    const [pipeline] = ExamGrading.aggregate.mock.calls[0];
    expect(pipeline[0]).toEqual({ $match: match });
    expect(pipeline[1].$group._id).toBe('$student');
    // dropoutRiskScore plafonné à 100 (échec*60 + (10-min(avg,10))*4)
    expect(pipeline[2].$addFields.dropoutRiskScore.$min[0]).toBe(100);
    // seuil appliqué après calcul
    const thresholdStage = pipeline.find((s) => s.$match && s.$match.dropoutRiskScore);
    expect(thresholdStage.$match.dropoutRiskScore).toEqual({ $gte: 50 });
    expect(pipeline).toContainEqual({ $sort: { dropoutRiskScore: -1 } });
    expect(pipeline).toContainEqual({ $skip: 10 });
    expect(pipeline).toContainEqual({ $limit: 20 });
    const lookup = pipeline.find((s) => s.$lookup);
    expect(lookup.$lookup.from).toBe('students');
  });

  test('aggregateSessionGradingStats : $in sessions PUBLISHED, $group par session', () => {
    repo.aggregateSessionGradingStats(['s1', 's2']);
    const [pipeline] = ExamGrading.aggregate.mock.calls[0];
    expect(pipeline[0]).toEqual({ $match: { examSession: { $in: ['s1', 's2'] }, status: 'PUBLISHED', isDeleted: false } });
    expect(pipeline[1].$group._id).toBe('$examSession');
    expect(pipeline[1].$group.passCount).toEqual({ $sum: { $cond: [{ $gte: ['$normalizedScore', 10] }, 1, 0] } });
  });
});
