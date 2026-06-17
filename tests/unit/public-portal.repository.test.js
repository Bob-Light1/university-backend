'use strict';

/**
 * Couche repository — module public-portal (R3 ; 7 models, exports PAR DÉFAUT).
 * Models mockés (sans DB) : CompetitionPrize, ContactMessage, CoursePreview,
 * FaqEntry, QuizQuestion, QuizSession, Testimonial.
 *
 * Mock de query chaînable ET thenable (cf. document.repository.test.js).
 *
 * Accent :
 *   - la *content-repo* liée (`contentRepo(name)`) consommée par la factory admin
 *     (tri contenu { order:1, createdAt:-1 }, doc complet sans select) ;
 *   - les sélections restreintes des lectures publiques ;
 *   - non-régression SÉCURITÉ du pipeline quiz : `$sample` + `$project` liste
 *     blanche (correctIndex et champs internes JAMAIS exposés) et `+correctIndex`
 *     forcé uniquement pour le scoring côté ERP.
 */

const buildModelMock = () => {
  function Model(data) { Object.assign(this, data); this._id = this._id || 'gen-id'; }
  Model.__lean = null;
  Model.__setLean = (v) => { Model.__lean = v; };

  const makeQuery = () => {
    const q = {};
    ['select', 'sort', 'skip', 'limit', 'populate', 'session', 'lean'].forEach((m) => {
      q[m] = jest.fn(() => q);
    });
    q.exec = jest.fn(() => Promise.resolve(Model.__lean));
    q.then = (resolve, reject) => Promise.resolve(Model.__lean).then(resolve, reject);
    return q;
  };

  ['find', 'findOne', 'findById'].forEach((m) => { Model[m] = jest.fn(() => makeQuery()); });
  Model.countDocuments    = jest.fn(() => makeQuery());
  Model.aggregate         = jest.fn(() => Promise.resolve([]));
  Model.create            = jest.fn((d) => Promise.resolve({ _id: 'created', ...d }));
  Model.findOneAndDelete  = jest.fn(() => Promise.resolve({ _id: 'deleted' }));
  Model.__makeQuery = makeQuery;
  return Model;
};

jest.mock('../../modules/public-portal/models/competition.prize.model', () => buildModelMock());
jest.mock('../../modules/public-portal/models/contact.message.model',   () => buildModelMock());
jest.mock('../../modules/public-portal/models/course.preview.model',    () => buildModelMock());
jest.mock('../../modules/public-portal/models/faq.entry.model',         () => buildModelMock());
jest.mock('../../modules/public-portal/models/quiz.question.model',     () => buildModelMock());
jest.mock('../../modules/public-portal/models/quiz.session.model',      () => buildModelMock());
jest.mock('../../modules/public-portal/models/testimonial.model',       () => buildModelMock());

const CompetitionPrize = require('../../modules/public-portal/models/competition.prize.model');
const ContactMessage   = require('../../modules/public-portal/models/contact.message.model');
const CoursePreview    = require('../../modules/public-portal/models/course.preview.model');
const FaqEntry         = require('../../modules/public-portal/models/faq.entry.model');
const QuizQuestion     = require('../../modules/public-portal/models/quiz.question.model');
const QuizSession      = require('../../modules/public-portal/models/quiz.session.model');
const Testimonial      = require('../../modules/public-portal/models/testimonial.model');
const repo = require('../../modules/public-portal/public-portal.repository');

const ALL = [CompetitionPrize, ContactMessage, CoursePreview, FaqEntry, QuizQuestion, QuizSession, Testimonial];
const CONTENT_SORT = { order: 1, createdAt: -1 };

beforeEach(() => {
  jest.clearAllMocks();
  ALL.forEach((M) => M.__setLean(null));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('content-repo générique (factory admin)', () => {
  test('contentRepo(name inconnu) : jette', () => {
    expect(() => repo.contentRepo('Nope')).toThrow(/Unknown public-portal content model/);
  });

  test('Testimonial → create délègue à Testimonial.create', () => {
    repo.contentRepo('Testimonial').create({ firstName: 'A' });
    expect(Testimonial.create).toHaveBeenCalledWith({ firstName: 'A' });
  });

  test('FaqEntry → paginate : find+sort contenu+skip+limit+lean, count → {data,total}', async () => {
    FaqEntry.__setLean([{ _id: 'f1' }]);
    FaqEntry.countDocuments.mockReturnValueOnce(Promise.resolve(5));
    const q = FaqEntry.__makeQuery();
    FaqEntry.find.mockReturnValueOnce(q);
    const out = await repo.contentRepo('FaqEntry').paginate({ schoolCampus: 'c' }, { skip: 0, limit: 20 });
    expect(FaqEntry.find).toHaveBeenCalledWith({ schoolCampus: 'c' });
    expect(q.sort).toHaveBeenCalledWith(CONTENT_SORT);
    expect(q.skip).toHaveBeenCalledWith(0);
    expect(q.limit).toHaveBeenCalledWith(20);
    expect(q.lean).toHaveBeenCalled();
    expect(out).toEqual({ data: [{ _id: 'f1' }], total: 5 });
  });

  test('CoursePreview → findOneLean (getOne, doc complet sans select)', () => {
    const q = CoursePreview.__makeQuery();
    CoursePreview.findOne.mockReturnValueOnce(q);
    repo.contentRepo('CoursePreview').findOneLean({ _id: 'x' });
    expect(CoursePreview.findOne).toHaveBeenCalledWith({ _id: 'x' });
    expect(q.select).not.toHaveBeenCalled();
    expect(q.lean).toHaveBeenCalled();
  });

  test('Testimonial → findOneForWrite : findOne SANS lean (doc à muter)', () => {
    const q = Testimonial.__makeQuery();
    Testimonial.findOne.mockReturnValueOnce(q);
    repo.contentRepo('Testimonial').findOneForWrite({ _id: 'x' });
    expect(q.lean).not.toHaveBeenCalled();
  });

  test('save délègue à doc.save()', () => {
    const save = jest.fn(() => Promise.resolve());
    repo.contentRepo('FaqEntry').save({ save });
    expect(save).toHaveBeenCalled();
  });

  test('findOneAndDelete : suppression scopée', () => {
    repo.contentRepo('CoursePreview').findOneAndDelete({ _id: 'x', schoolCampus: 'c' });
    expect(CoursePreview.findOneAndDelete).toHaveBeenCalledWith({ _id: 'x', schoolCampus: 'c' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('lectures publiques de contenu (sélections restreintes)', () => {
  test('listPublicTestimonials : sort contenu+limit+select restreint+lean', () => {
    const q = Testimonial.__makeQuery();
    Testimonial.find.mockReturnValueOnce(q);
    repo.listPublicTestimonials({ schoolCampus: 'c', isPublished: true }, 6);
    expect(Testimonial.find).toHaveBeenCalledWith({ schoolCampus: 'c', isPublished: true });
    expect(q.sort).toHaveBeenCalledWith(CONTENT_SORT);
    expect(q.limit).toHaveBeenCalledWith(6);
    expect(q.select).toHaveBeenCalledWith('firstName city graduationYear program quote photoUrl employer');
    expect(q.lean).toHaveBeenCalled();
  });

  test('listPublicFaq : sort contenu+select(question answer category)+lean', () => {
    const q = FaqEntry.__makeQuery();
    FaqEntry.find.mockReturnValueOnce(q);
    repo.listPublicFaq({ schoolCampus: 'c', isPublished: true });
    expect(q.select).toHaveBeenCalledWith('question answer category');
    expect(q.lean).toHaveBeenCalled();
  });

  test('listPublicCoursePreviews : select(program title content videoUrl)+lean', () => {
    const q = CoursePreview.__makeQuery();
    CoursePreview.find.mockReturnValueOnce(q);
    repo.listPublicCoursePreviews({ schoolCampus: 'c', isPublished: true, program: 'X' });
    expect(CoursePreview.find).toHaveBeenCalledWith({ schoolCampus: 'c', isPublished: true, program: 'X' });
    expect(q.select).toHaveBeenCalledWith('program title content videoUrl');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('competition prize', () => {
  test('createCompetition : CompetitionPrize.create(doc)', () => {
    repo.createCompetition({ period: '2026-06' });
    expect(CompetitionPrize.create).toHaveBeenCalledWith({ period: '2026-06' });
  });

  test('paginateCompetitions : sort période desc → {data,total}', async () => {
    CompetitionPrize.__setLean([{ period: '2026-06' }]);
    CompetitionPrize.countDocuments.mockReturnValueOnce(Promise.resolve(1));
    const q = CompetitionPrize.__makeQuery();
    CompetitionPrize.find.mockReturnValueOnce(q);
    const out = await repo.paginateCompetitions({ schoolCampus: 'c' }, { skip: 0, limit: 20 });
    expect(q.sort).toHaveBeenCalledWith({ period: -1 });
    expect(out).toEqual({ data: [{ period: '2026-06' }], total: 1 });
  });

  test('findCompetitionLean : findOne(filter)+lean (getOne admin)', () => {
    const q = CompetitionPrize.__makeQuery();
    CompetitionPrize.findOne.mockReturnValueOnce(q);
    repo.findCompetitionLean({ _id: 'x' });
    expect(q.lean).toHaveBeenCalled();
  });

  test('findCompetitionForWrite : findOne SANS lean', () => {
    const q = CompetitionPrize.__makeQuery();
    CompetitionPrize.findOne.mockReturnValueOnce(q);
    repo.findCompetitionForWrite({ _id: 'x' });
    expect(q.lean).not.toHaveBeenCalled();
  });

  test('findCompetitionScopedStatus : select(_id isActive) (garde de clôture)', () => {
    const q = CompetitionPrize.__makeQuery();
    CompetitionPrize.findOne.mockReturnValueOnce(q);
    repo.findCompetitionScopedStatus({ _id: 'x' });
    expect(q.select).toHaveBeenCalledWith('_id isActive');
    expect(q.lean).not.toHaveBeenCalled();
  });

  test('findCompetitionByIdLean : findById+lean (état figé)', () => {
    const q = CompetitionPrize.__makeQuery();
    CompetitionPrize.findById.mockReturnValueOnce(q);
    repo.findCompetitionByIdLean('x');
    expect(CompetitionPrize.findById).toHaveBeenCalledWith('x');
    expect(q.lean).toHaveBeenCalled();
  });

  test('findCompetitionByIdForWrite : findById SANS lean (cron clôture)', () => {
    const q = CompetitionPrize.__makeQuery();
    CompetitionPrize.findById.mockReturnValueOnce(q);
    repo.findCompetitionByIdForWrite('x');
    expect(q.lean).not.toHaveBeenCalled();
  });

  test('saveCompetitionDoc : doc.save()', () => {
    const save = jest.fn(() => Promise.resolve());
    repo.saveCompetitionDoc({ save });
    expect(save).toHaveBeenCalled();
  });

  test('deleteCompetition : findOneAndDelete(filter)', () => {
    repo.deleteCompetition({ _id: 'x', schoolCampus: 'c' });
    expect(CompetitionPrize.findOneAndDelete).toHaveBeenCalledWith({ _id: 'x', schoolCampus: 'c' });
  });

  test('findActiveCompetitionsBeforePeriod : filtre {isActive,period:$lt}+select(_id)+lean', () => {
    const q = CompetitionPrize.__makeQuery();
    CompetitionPrize.find.mockReturnValueOnce(q);
    repo.findActiveCompetitionsBeforePeriod('2026-06');
    expect(CompetitionPrize.find).toHaveBeenCalledWith({ isActive: true, period: { $lt: '2026-06' } });
    expect(q.select).toHaveBeenCalledWith('_id');
    expect(q.lean).toHaveBeenCalled();
  });

  test('findActivePublicCompetition : sort période desc+select(period prizes closingDate winners)+lean', () => {
    const q = CompetitionPrize.__makeQuery();
    CompetitionPrize.findOne.mockReturnValueOnce(q);
    repo.findActivePublicCompetition({ schoolCampus: 'c', isActive: true });
    expect(q.sort).toHaveBeenCalledWith({ period: -1 });
    expect(q.select).toHaveBeenCalledWith('period prizes closingDate winners');
    expect(q.lean).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('quiz session', () => {
  test('createQuizSession : QuizSession.create(payload)', () => {
    repo.createQuizSession({ sessionToken: 't' });
    expect(QuizSession.create).toHaveBeenCalledWith({ sessionToken: 't' });
  });

  test('findQuizSessionByToken : findOne({sessionToken})+lean', () => {
    const q = QuizSession.__makeQuery();
    QuizSession.findOne.mockReturnValueOnce(q);
    repo.findQuizSessionByToken('tok');
    expect(QuizSession.findOne).toHaveBeenCalledWith({ sessionToken: 'tok' });
    expect(q.lean).toHaveBeenCalled();
  });

  test('findTopQuizSessions : filtre complété+sort score/temps+limit+select minimal+lean', () => {
    const q = QuizSession.__makeQuery();
    QuizSession.find.mockReturnValueOnce(q);
    repo.findTopQuizSessions({ schoolCampus: 'c', period: '2026-06' }, 10);
    expect(QuizSession.find).toHaveBeenCalledWith({ schoolCampus: 'c', period: '2026-06', completedAt: { $ne: null } });
    expect(q.sort).toHaveBeenCalledWith({ score: -1, completedAt: 1 });
    expect(q.limit).toHaveBeenCalledWith(10);
    expect(q.select).toHaveBeenCalledWith('_id lead displayName score');
    expect(q.lean).toHaveBeenCalled();
  });

  test('findLeaderboardEntries : filtre fourni+sort+limit+select public (aucune donnée perso)', () => {
    const q = QuizSession.__makeQuery();
    QuizSession.find.mockReturnValueOnce(q);
    const filter = { period: '2026-06', completedAt: { $ne: null }, schoolCampus: 'c' };
    repo.findLeaderboardEntries(filter, 50);
    expect(QuizSession.find).toHaveBeenCalledWith(filter);
    expect(q.sort).toHaveBeenCalledWith({ score: -1, completedAt: 1 });
    expect(q.limit).toHaveBeenCalledWith(50);
    expect(q.select).toHaveBeenCalledWith('displayName city country score category period completedAt');
    expect(q.lean).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('quiz question (sécurité correctIndex)', () => {
  test('sampleQuizQuestions : $match fourni + $sample + $project liste blanche (PAS de correctIndex)', async () => {
    QuizQuestion.aggregate.mockReturnValueOnce(Promise.resolve([{ _id: 'q1' }]));
    const match = { schoolCampus: 'c', isPublished: true, category: 'general' };
    const out = await repo.sampleQuizQuestions(match, 10);
    expect(QuizQuestion.aggregate).toHaveBeenCalledWith([
      { $match: match },
      { $sample: { size: 10 } },
      { $project: { _id: 1, text: 1, options: 1, category: 1, difficulty: 1, lang: 1 } },
    ]);
    const project = QuizQuestion.aggregate.mock.calls[0][0][2].$project;
    expect(project).not.toHaveProperty('correctIndex');
    expect(out).toEqual([{ _id: 'q1' }]);
  });

  test('findPublishedQuestionsWithAnswers : find(filter)+select(+correctIndex)+lean (scoring ERP)', () => {
    const q = QuizQuestion.__makeQuery();
    QuizQuestion.find.mockReturnValueOnce(q);
    const filter = { _id: { $in: ['a'] }, schoolCampus: 'c', isPublished: true };
    repo.findPublishedQuestionsWithAnswers(filter);
    expect(QuizQuestion.find).toHaveBeenCalledWith(filter);
    expect(q.select).toHaveBeenCalledWith('+correctIndex');
    expect(q.lean).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('contact message', () => {
  test('createContactMessage : ContactMessage.create(payload)', () => {
    repo.createContactMessage({ name: 'A', message: 'hi' });
    expect(ContactMessage.create).toHaveBeenCalledWith({ name: 'A', message: 'hi' });
  });
});
