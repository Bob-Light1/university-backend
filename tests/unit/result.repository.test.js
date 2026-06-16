'use strict';

/**
 * Couche repository — module result (R3, cœur académique ; 3 models).
 * Models mockés (sans DB) : Result, FinalTranscript, GradingScale.
 *
 * jest.mock impose des chemins littéraux + une factory auto-suffisante (hoisting :
 * buildModelMock est une déclaration de fonction, donc hissée). Chaque model est
 * un constructeur doté de statiques jest.fn ; les queries sont chaînables
 * (select/sort/skip/limit/populate/session) et .lean/.exec résolvent __setLean.
 *
 * Accent mis sur les agrégats (non-régression des sorties relevé à la volée /
 * overview campus / étudiants distincts de clôture) et les formes de requête
 * sensibles (session de transaction RETAKE, lean virtuals du portail parent,
 * populate de la liste de rattrapage, token de vérification publique).
 */

const buildModelMock = () => {
  let leanVal = null;
  const makeQuery = () => {
    const q = {};
    ['select', 'sort', 'skip', 'limit', 'populate', 'session'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.lean = jest.fn(() => Promise.resolve(leanVal));
    q.exec = jest.fn(() => Promise.resolve(leanVal));
    q.then = (resolve) => Promise.resolve(leanVal).then(resolve);
    return q;
  };
  function Model(data) { Object.assign(this, data); this._id = this._id || 'gen-id'; }
  Model.prototype.save = jest.fn(function save() { return Promise.resolve(this); });
  ['find', 'findOne', 'findById', 'findOneAndUpdate', 'updateOne', 'updateMany'].forEach((m) => {
    Model[m] = jest.fn(() => makeQuery());
  });
  Model.countDocuments = jest.fn(() => makeQuery());
  Model.aggregate = jest.fn(() => Promise.resolve([]));
  Model.create = jest.fn((d) => Promise.resolve({ _id: 'created', ...d }));
  Model.insertMany = jest.fn((docs) => Promise.resolve(docs));
  // statiques métier (logique de la couche model invoquée par le repo)
  Model.computeDropoutRisk = jest.fn(() => Promise.resolve(42));
  Model.getClassDistribution = jest.fn(() => Promise.resolve({ mean: 12 }));
  Model.generateForStudent = jest.fn(() => Promise.resolve({ _id: 'transcript1' }));
  Model.__setLean = (v) => { leanVal = v; };
  return Model;
};

jest.mock('../../modules/result/models/result.model', () => ({ Result: buildModelMock() }));
jest.mock('../../modules/result/models/final-transcript.model', () => ({ FinalTranscript: buildModelMock() }));
jest.mock('../../modules/result/models/grading-scale.model', () => ({ GradingScale: buildModelMock() }));

const { Result }          = require('../../modules/result/models/result.model');
const { FinalTranscript } = require('../../modules/result/models/final-transcript.model');
const { GradingScale }    = require('../../modules/result/models/grading-scale.model');
const repo = require('../../modules/result/result.repository');

beforeEach(() => {
  jest.clearAllMocks();
  [Result, FinalTranscript, GradingScale].forEach((M) => M.__setLean(null));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('result — création & écritures', () => {
  test('createResult : Result.create avec le payload', () => {
    repo.createResult({ score: 12 });
    expect(Result.create).toHaveBeenCalledWith({ score: 12 });
  });

  test('insertManyResults : insertMany ordered:false (laisse passer les doublons)', () => {
    repo.insertManyResults([{ s: 1 }]);
    expect(Result.insertMany).toHaveBeenCalledWith([{ s: 1 }], { ordered: false });
  });

  test('saveResultDoc : délègue à doc.save (avec opts session)', () => {
    const save = jest.fn(() => Promise.resolve());
    const doc = { save };
    repo.saveResultDoc(doc, { session: 'S' });
    expect(save).toHaveBeenCalledWith({ session: 'S' });
  });

  test('updateManyResults : updateMany(filter, update)', () => {
    repo.updateManyResults({ status: 'DRAFT' }, { $set: { status: 'SUBMITTED' } });
    expect(Result.updateMany).toHaveBeenCalledWith({ status: 'DRAFT' }, { $set: { status: 'SUBMITTED' } });
  });

  test('setDropoutRiskScore : updateOne atomique sur dropoutRiskScore', () => {
    repo.setDropoutRiskScore('r1', 60);
    expect(Result.updateOne).toHaveBeenCalledWith({ _id: 'r1' }, { $set: { dropoutRiskScore: 60 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('result — lectures', () => {
  test('paginateResults : find+sort createdAt desc+populate(student/subject/teacher/class)+lean, count → {docs,total}', async () => {
    Result.__setLean([{ _id: 'r1' }]);
    Result.countDocuments.mockReturnValueOnce(Promise.resolve(3));
    const q = Result.find();
    Result.find.mockReturnValueOnce(q);
    const out = await repo.paginateResults({ isDeleted: false }, { skip: 0, limit: 50 });
    expect(Result.find).toHaveBeenLastCalledWith({ isDeleted: false });
    expect(q.sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(q.populate).toHaveBeenCalledWith({ path: 'student', select: 'firstName lastName matricule' });
    expect(q.populate).toHaveBeenCalledWith({ path: 'class', select: 'className' });
    expect(q.skip).toHaveBeenCalledWith(0);
    expect(q.limit).toHaveBeenCalledWith(50);
    expect(q.lean).toHaveBeenCalled();
    expect(out).toEqual({ docs: [{ _id: 'r1' }], total: 3 });
  });

  test('findResultByIdPopulated : findOne non supprimé + populate DETAIL (classManager/gradingScale) + lean', () => {
    const q = Result.findOne();
    Result.findOne.mockReturnValueOnce(q);
    repo.findResultByIdPopulated('r1');
    expect(Result.findOne).toHaveBeenLastCalledWith({ _id: 'r1', isDeleted: false });
    expect(q.populate).toHaveBeenCalledWith({ path: 'classManager', select: 'firstName lastName email' });
    expect(q.populate).toHaveBeenCalledWith({ path: 'gradingScale', select: 'name system maxScore passMark bands' });
    expect(q.lean).toHaveBeenCalled();
  });

  test('findResultForWrite : findOne non supprimé SANS lean (doc à muter)', () => {
    const q = Result.findOne();
    Result.findOne.mockReturnValueOnce(q);
    repo.findResultForWrite('r1');
    expect(Result.findOne).toHaveBeenLastCalledWith({ _id: 'r1', isDeleted: false });
    expect(q.lean).not.toHaveBeenCalled();
  });

  test('findResultById : findById + session (note originale du RETAKE en transaction)', () => {
    const q = Result.findById();
    Result.findById.mockReturnValueOnce(q);
    repo.findResultById('orig1', { session: 'TX' });
    expect(Result.findById).toHaveBeenLastCalledWith('orig1');
    expect(q.session).toHaveBeenCalledWith('TX');
  });

  test('findResultById : sans session → session(null)', () => {
    const q = Result.findById();
    Result.findById.mockReturnValueOnce(q);
    repo.findResultById('orig1');
    expect(q.session).toHaveBeenCalledWith(null);
  });

  test('findResultsForWrite : find(filter) SANS lean (docs pour save par lot)', () => {
    const q = Result.find();
    Result.find.mockReturnValueOnce(q);
    repo.findResultsForWrite({ status: 'SUBMITTED' });
    expect(Result.find).toHaveBeenLastCalledWith({ status: 'SUBMITTED' });
    expect(q.lean).not.toHaveBeenCalled();
  });

  test('listRetakeResults : populate student/subject + tri normalizedScore croissant + lean', () => {
    const q = Result.find();
    Result.find.mockReturnValueOnce(q);
    repo.listRetakeResults({ isRetakeEligible: true });
    expect(q.populate).toHaveBeenCalledWith('student', 'firstName lastName matricule email');
    expect(q.sort).toHaveBeenCalledWith({ normalizedScore: 1 });
    expect(q.lean).toHaveBeenCalled();
  });

  test('findResultByVerificationToken : findOne token+non supprimé, lean, sans données sensibles', () => {
    const q = Result.findOne();
    Result.findOne.mockReturnValueOnce(q);
    repo.findResultByVerificationToken('tok');
    expect(Result.findOne).toHaveBeenLastCalledWith({ verificationToken: 'tok', isDeleted: false });
    expect(q.lean).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('result — statiques métier déléguées', () => {
  test('computeDropoutRisk : délègue à Result.computeDropoutRisk', async () => {
    await repo.computeDropoutRisk('stu1', 'cmp1');
    expect(Result.computeDropoutRisk).toHaveBeenCalledWith('stu1', 'cmp1');
  });

  test('getClassDistribution : délègue à Result.getClassDistribution (5 args)', async () => {
    await repo.getClassDistribution('cl', 'su', 'Eval', '2024-2025', 'S1');
    expect(Result.getClassDistribution).toHaveBeenCalledWith('cl', 'su', 'Eval', '2024-2025', 'S1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('result — agrégats (non-régression des pipelines)', () => {
  test('aggregateDistinctStudentsForLock : $match fourni + $group student → classId/campusId', () => {
    const match = { academicYear: '2024-2025', semester: 'S1' };
    repo.aggregateDistinctStudentsForLock(match);
    const [pipeline] = Result.aggregate.mock.calls[0];
    expect(pipeline[0]).toEqual({ $match: match });
    expect(pipeline[1].$group._id).toBe('$student');
    expect(pipeline[1].$group.classId).toEqual({ $first: '$class' });
    expect(pipeline[1].$group.campusId).toEqual({ $first: '$schoolCampus' });
  });

  test('aggregateStudentTranscript : $match casté fourni, groupe (year,sem,subject), lookup subjects, tri year desc/sem asc', () => {
    const match = { student: 'OID', isDeleted: false };
    repo.aggregateStudentTranscript(match);
    const [pipeline] = Result.aggregate.mock.calls[0];
    expect(pipeline[0]).toEqual({ $match: match });
    expect(pipeline[1].$group._id).toEqual({ academicYear: '$academicYear', semester: '$semester', subject: '$subject' });
    expect(pipeline[1].$group.subjectAvg).toEqual({ $avg: { $multiply: [{ $divide: ['$score', '$maxScore'] }, 20] } });
    const lookup = pipeline.find((s) => s.$lookup);
    expect(lookup.$lookup.from).toBe('subjects');
    expect(pipeline[pipeline.length - 1]).toEqual({ $sort: { '_id.academicYear': -1, '_id.semester': 1 } });
  });

  test('aggregateCampusOverview : $match fourni + facettes statut/type/période + generalStats (taux réussite/à risque)', () => {
    const match = { isDeleted: false, schoolCampus: 'c1' };
    repo.aggregateCampusOverview(match);
    const [pipeline] = Result.aggregate.mock.calls[0];
    expect(pipeline[0]).toEqual({ $match: match });
    const facet = pipeline[1].$facet;
    expect(Object.keys(facet)).toEqual(['byStatus', 'byEvalType', 'byExamPeriod', 'generalStats']);
    // generalStats ne compte que PUBLISHED/ARCHIVED non supprimés
    expect(facet.generalStats[0].$match).toEqual({ status: { $in: ['PUBLISHED', 'ARCHIVED'] }, isDeleted: false });
    const grp = facet.generalStats[1].$group;
    expect(grp.passingCount).toEqual({ $sum: { $cond: [{ $gte: ['$normalizedScore', 10] }, 1, 0] } });
    expect(grp.atRisk).toEqual({ $sum: { $cond: [{ $gte: ['$dropoutRiskScore', 60] }, 1, 0] } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('result — service inter-modules', () => {
  test('countResults : countDocuments(filter)', () => {
    repo.countResults({ status: 'PUBLISHED' });
    expect(Result.countDocuments).toHaveBeenCalledWith({ status: 'PUBLISHED' });
  });

  test('paginateCampusResults : populate student/subject/class, tri createdAt desc, lean → {docs,total}', async () => {
    Result.__setLean([{ _id: 'r1' }]);
    Result.countDocuments.mockReturnValueOnce(Promise.resolve(7));
    const q = Result.find();
    Result.find.mockReturnValueOnce(q);
    const out = await repo.paginateCampusResults({ schoolCampus: 'c1' }, { skip: 0, limit: 20 });
    expect(q.populate).toHaveBeenCalledWith('student', 'firstName lastName matricule profileImage');
    expect(q.sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(out).toEqual({ docs: [{ _id: 'r1' }], total: 7 });
  });

  test('paginateStudentPublishedResults : lean virtuals, tri examDate/publishedAt desc → {results,total}', async () => {
    Result.__setLean([{ _id: 'r1' }]);
    Result.countDocuments.mockReturnValueOnce(Promise.resolve(2));
    const q = Result.find();
    Result.find.mockReturnValueOnce(q);
    const out = await repo.paginateStudentPublishedResults({ student: 's1' }, { skip: 0, limit: 20 });
    expect(q.sort).toHaveBeenCalledWith({ examDate: -1, publishedAt: -1 });
    expect(q.lean).toHaveBeenCalledWith({ virtuals: true });
    expect(out).toEqual({ results: [{ _id: 'r1' }], total: 2 });
  });

  test('paginateStudentResultComments : tri publishedAt desc, lean virtuals → {comments,total}', async () => {
    Result.__setLean([{ _id: 'c1' }]);
    Result.countDocuments.mockReturnValueOnce(Promise.resolve(1));
    const q = Result.find();
    Result.find.mockReturnValueOnce(q);
    const out = await repo.paginateStudentResultComments({ student: 's1' }, { skip: 0, limit: 20 });
    expect(q.sort).toHaveBeenCalledWith({ publishedAt: -1 });
    expect(q.lean).toHaveBeenCalledWith({ virtuals: true });
    expect(out).toEqual({ comments: [{ _id: 'c1' }], total: 1 });
  });

  test('findRecentResultsForStudent : limit appliqué + lean virtuals + populate subject', () => {
    const q = Result.find();
    Result.find.mockReturnValueOnce(q);
    repo.findRecentResultsForStudent({ student: 's1' }, 5);
    expect(q.populate).toHaveBeenCalledWith('subject', 'subject_name subject_code');
    expect(q.limit).toHaveBeenCalledWith(5);
    expect(q.lean).toHaveBeenCalledWith({ virtuals: true });
  });

  test('findRecentResultsForStudents : tri createdAt desc + lean simple (sans virtuals)', () => {
    const q = Result.find();
    Result.find.mockReturnValueOnce(q);
    repo.findRecentResultsForStudents({ student: { $in: ['s1'] } }, 5);
    expect(q.sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(q.lean).toHaveBeenCalledWith();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('finalTranscript', () => {
  test('generateTranscriptForStudent : délègue à FinalTranscript.generateForStudent', async () => {
    await repo.generateTranscriptForStudent({ studentId: 's1' });
    expect(FinalTranscript.generateForStudent).toHaveBeenCalledWith({ studentId: 's1' });
  });

  test('findTranscriptForStudentPopulated : findOne(student/year/sem) + populate + lean', () => {
    const q = FinalTranscript.findOne();
    FinalTranscript.findOne.mockReturnValueOnce(q);
    repo.findTranscriptForStudentPopulated({ studentId: 's1', academicYear: '2024-2025', semester: 'S1' });
    expect(FinalTranscript.findOne).toHaveBeenLastCalledWith({ student: 's1', academicYear: '2024-2025', semester: 'S1' });
    expect(q.populate).toHaveBeenCalledWith('class', 'className');
    expect(q.lean).toHaveBeenCalled();
  });

  test('findTranscriptForWrite : findById SANS lean (doc à signer/valider)', () => {
    const q = FinalTranscript.findById();
    FinalTranscript.findById.mockReturnValueOnce(q);
    repo.findTranscriptForWrite('t1');
    expect(FinalTranscript.findById).toHaveBeenLastCalledWith('t1');
    expect(q.lean).not.toHaveBeenCalled();
  });

  test('saveTranscriptDoc : délègue à doc.save', () => {
    const save = jest.fn(() => Promise.resolve());
    repo.saveTranscriptDoc({ save });
    expect(save).toHaveBeenCalled();
  });

  test('listStudentTranscripts : tri year desc/sem asc + lean virtuals', () => {
    const q = FinalTranscript.find();
    FinalTranscript.find.mockReturnValueOnce(q);
    repo.listStudentTranscripts({ student: 's1' });
    expect(q.sort).toHaveBeenCalledWith({ academicYear: -1, semester: 1 });
    expect(q.lean).toHaveBeenCalledWith({ virtuals: true });
  });

  test('findTranscriptForSignature : findOne scopé _id/student/schoolCampus, SANS lean', () => {
    const q = FinalTranscript.findOne();
    FinalTranscript.findOne.mockReturnValueOnce(q);
    repo.findTranscriptForSignature({ transcriptId: 't1', studentId: 's1', campusId: 'c1' });
    expect(FinalTranscript.findOne).toHaveBeenLastCalledWith({ _id: 't1', student: 's1', schoolCampus: 'c1' });
    expect(q.lean).not.toHaveBeenCalled();
  });

  test('findTranscriptForPrint : findOne(student/campus/year/sem) + lean', () => {
    const q = FinalTranscript.findOne();
    FinalTranscript.findOne.mockReturnValueOnce(q);
    repo.findTranscriptForPrint({ studentId: 's1', campusId: 'c1', academicYear: '2024-2025', semester: 'S1' });
    expect(FinalTranscript.findOne).toHaveBeenLastCalledWith({ student: 's1', schoolCampus: 'c1', academicYear: '2024-2025', semester: 'S1' });
    expect(q.lean).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('gradingScale', () => {
  test('listActiveGradingScales : isActive:true + campusFilter, tri défaut puis nom, lean', () => {
    const q = GradingScale.find();
    GradingScale.find.mockReturnValueOnce(q);
    repo.listActiveGradingScales({ schoolCampus: 'c1' });
    expect(GradingScale.find).toHaveBeenLastCalledWith({ isActive: true, schoolCampus: 'c1' });
    expect(q.sort).toHaveBeenCalledWith({ isDefault: -1, name: 1 });
    expect(q.lean).toHaveBeenCalled();
  });

  test('createGradingScale : GradingScale.create(payload)', () => {
    repo.createGradingScale({ name: 'B' });
    expect(GradingScale.create).toHaveBeenCalledWith({ name: 'B' });
  });

  test('findGradingScaleForWrite : findById SANS lean (doc à muter)', () => {
    const q = GradingScale.findById();
    GradingScale.findById.mockReturnValueOnce(q);
    repo.findGradingScaleForWrite('g1');
    expect(GradingScale.findById).toHaveBeenLastCalledWith('g1');
    expect(q.lean).not.toHaveBeenCalled();
  });

  test('saveGradingScaleDoc : délègue à doc.save (validation pre-save des bands)', () => {
    const save = jest.fn(() => Promise.resolve());
    repo.saveGradingScaleDoc({ save });
    expect(save).toHaveBeenCalled();
  });
});
