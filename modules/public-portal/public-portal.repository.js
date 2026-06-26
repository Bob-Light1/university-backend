'use strict';

/**
 * @file public-portal.repository.js — data access layer for the public-portal module.
 *
 * The ONLY file allowed to touch the 7 owned models:
 *   - CompetitionPrize (competition.prize.model)
 *   - ContactMessage   (contact.message.model)
 *   - CoursePreview    (course.preview.model)
 *   - FaqEntry         (faq.entry.model)
 *   - QuizQuestion     (quiz.question.model)
 *   - QuizSession      (quiz.session.model)
 *   - Testimonial      (testimonial.model)
 *
 * Consumers: public controllers (quiz/leaderboard/testimonials/faq/courses/
 * contact/competition), portal-admin back-office (generic content factory +
 * competition.admin), the monthly closing cron and the winner notification
 * service. They all go exclusively through it.
 *
 * Conventions:
 *   - Reads → plain objects (`.lean()`); query shapes (select,
 *     sort, $sample/$project) live HERE.
 *   - Hooked writes (schema validations, period/score generation) via
 *     create() or load→mutate→save (findXxxForWrite + saveXxxDoc).
 *   - Campus isolation / scope filters and the `$in` values cast to ObjectId
 *     are built by the caller and passed through as-is.
 *   - The admin content factory (Testimonial/FaqEntry/CoursePreview share
 *     the same shape) consumes a *content-repo* bound to the model via
 *     `contentRepo(name)` — the factory no longer touches any model directly.
 *
 * Accepted exceptions (stay outside the repo):
 *   - ObjectId cast/validation (mongoose.Types.ObjectId): in the controllers
 *     that build the filters.
 *   - Business logic (score computation, ranking, current period, winner
 *     anonymization, email/SMS sending): stays in controllers / cron / notification.
 */

const CompetitionPrize = require('./models/competition.prize.model');
const ContactMessage   = require('./models/contact.message.model');
const CoursePreview    = require('./models/course.preview.model');
const FaqEntry         = require('./models/faq.entry.model');
const QuizQuestion     = require('./models/quiz.question.model');
const QuizSession      = require('./models/quiz.session.model');
const Testimonial      = require('./models/testimonial.model');

// ─────────────────────────────────────────────────────────────────────────────
// GENERIC ADMIN CONTENT (Testimonial / FaqEntry / CoursePreview)
// ─────────────────────────────────────────────────────────────────────────────

/** Common sort for content resources (manual order then recency). */
const CONTENT_SORT = { order: 1, createdAt: -1 };

/**
 * Builds a content-repo bound to a given model — six CRUD operations
 * consumed by the `makeContentController` factory. The factory thus never
 * has a direct reference to a model.
 */
const makeContentRepo = (Model) => ({
  /** Creates a content resource (triggers schema validation). */
  create: (doc) => Model.create(doc),

  /** Paginated list + count, content sort. Returns { data, total }. */
  paginate: async (filter, { skip, limit }) => {
    const [data, total] = await Promise.all([
      Model.find(filter).sort(CONTENT_SORT).skip(skip).limit(limit).lean(),
      Model.countDocuments(filter),
    ]);
    return { data, total };
  },

  /** Scoped lean read (getOne). */
  findOneLean: (filter) => Model.findOne(filter).lean(),

  /** Scoped non-lean doc for writing (update / togglePublish). */
  findOneForWrite: (filter) => Model.findOne(filter),

  /** Persists a content doc (triggers the save hooks). */
  save: (doc) => doc.save(),

  /** Scoped deletion (remove). */
  findOneAndDelete: (filter) => Model.findOneAndDelete(filter),
});

const CONTENT_REPOS = {
  Testimonial:   makeContentRepo(Testimonial),
  FaqEntry:      makeContentRepo(FaqEntry),
  CoursePreview: makeContentRepo(CoursePreview),
};

/** Returns the content-repo bound to the named model (consumed by the admin routes). */
const contentRepo = (name) => {
  const r = CONTENT_REPOS[name];
  if (!r) throw new Error(`Unknown public-portal content model: ${name}`);
  return r;
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC CONTENT READS (selections restricted to the portal)
// ─────────────────────────────────────────────────────────────────────────────

/** Published testimonials for a campus (filter provided), content sort, lean. */
const listPublicTestimonials = (filter, limit) =>
  Testimonial.find(filter)
    .sort(CONTENT_SORT)
    .limit(limit)
    .select('firstName city graduationYear program quote photoUrl employer')
    .lean();

/** Published FAQ entries for a campus (filter provided), content sort, lean. */
const listPublicFaq = (filter) =>
  FaqEntry.find(filter)
    .sort(CONTENT_SORT)
    .select('question answer category')
    .lean();

/** Published course previews for a campus (filter provided), content sort, lean. */
const listPublicCoursePreviews = (filter) =>
  CoursePreview.find(filter)
    .sort(CONTENT_SORT)
    .select('program title content videoUrl')
    .lean();

// ─────────────────────────────────────────────────────────────────────────────
// COMPETITION PRIZE
// ─────────────────────────────────────────────────────────────────────────────

/** Creates a competition (campus+period uniqueness enforced by index). */
const createCompetition = (doc) => CompetitionPrize.create(doc);

/** Paginated list of competitions (filter provided), period desc sort → { data, total }. */
const paginateCompetitions = async (filter, { skip, limit }) => {
  const [data, total] = await Promise.all([
    CompetitionPrize.find(filter).sort({ period: -1 }).skip(skip).limit(limit).lean(),
    CompetitionPrize.countDocuments(filter),
  ]);
  return { data, total };
};

/** Scoped competition, lean read (admin getOne). */
const findCompetitionLean = (filter) => CompetitionPrize.findOne(filter).lean();

/** Scoped non-lean competition for writing (update / toggleActive). */
const findCompetitionForWrite = (filter) => CompetitionPrize.findOne(filter);

/** Scope guard before immediate closing (status only). */
const findCompetitionScopedStatus = (filter) =>
  CompetitionPrize.findOne(filter).select('_id isActive');

/** Competition by id, lean read (state frozen after closing). */
const findCompetitionByIdLean = (id) => CompetitionPrize.findById(id).lean();

/** Competition by id, non-lean for writing (closed by the cron: winners[]+save). */
const findCompetitionByIdForWrite = (id) => CompetitionPrize.findById(id);

/** Persists a competition doc (frozen winners, notifiedAt). */
const saveCompetitionDoc = (doc) => doc.save();

/** Scoped deletion of a competition (admin remove). */
const deleteCompetition = (filter) => CompetitionPrize.findOneAndDelete(filter);

/** Active competitions whose period is strictly earlier (cron, lean). */
const findActiveCompetitionsBeforePeriod = (period) =>
  CompetitionPrize.find({ isActive: true, period: { $lt: period } })
    .select('_id')
    .lean();

/** Most recent active competition for a campus (filter provided), public view. */
const findActivePublicCompetition = (filter) =>
  CompetitionPrize.findOne(filter)
    .sort({ period: -1 })
    .select('period prizes closingDate winners')
    .lean();

// ─────────────────────────────────────────────────────────────────────────────
// QUIZ SESSION
// ─────────────────────────────────────────────────────────────────────────────

/** Creates a quiz session (pending at serve time, or a completed record). */
const createQuizSession = (payload) => QuizSession.create(payload);

/** Session by submission token (anti-double-submission), lean. */
const findQuizSessionByToken = (sessionToken) =>
  QuizSession.findOne({ sessionToken }).lean();

/** Non-lean session by token — loaded to score and flip pending → completed. */
const findQuizSessionForWriteByToken = (sessionToken) =>
  QuizSession.findOne({ sessionToken });

/** Persists a quiz session doc (triggers schema validation in pre-save). */
const saveQuizSessionDoc = (doc) => doc.save();

/**
 * Best completed sessions for a period/campus (cron closing).
 * Sort by best score then fastest; minimal selection to freeze winners[].
 */
const findTopQuizSessions = ({ schoolCampus, period }, limit) =>
  QuizSession.find({ schoolCampus, period, completedAt: { $ne: null } })
    .sort({ score: -1, completedAt: 1 })
    .limit(limit)
    .select('_id lead displayName score')
    .lean();

/**
 * Public ranking for a period (scope filter provided: campus/national +
 * category). Sort by best score then fastest; no personal data.
 */
const findLeaderboardEntries = (filter, limit) =>
  QuizSession.find(filter)
    .sort({ score: -1, completedAt: 1 })
    .limit(limit)
    .select('displayName city country score category period completedAt')
    .lean();

// ─────────────────────────────────────────────────────────────────────────────
// QUIZ QUESTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Random sample of published questions (filter provided). `$sample` does not
 * respect `select:false` → explicit whitelist via `$project`
 * (correctIndex and internal fields never exposed).
 */
const sampleQuizQuestions = (matchFilter, size) =>
  QuizQuestion.aggregate([
    { $match: matchFilter },
    { $sample: { size } },
    { $project: { _id: 1, text: 1, options: 1, category: 1, difficulty: 1, lang: 1 } },
  ]);

/**
 * Published questions for a campus used to compute the score (filter provided with
 * cast ids). `+correctIndex` forces inclusion of the `select:false` field on the ERP side.
 */
const findPublishedQuestionsWithAnswers = (filter) =>
  QuizQuestion.find(filter).select('+correctIndex').lean();

// ─────────────────────────────────────────────────────────────────────────────
// CONTACT MESSAGE
// ─────────────────────────────────────────────────────────────────────────────

/** Creates a contact message (public form). */
const createContactMessage = (payload) => ContactMessage.create(payload);

module.exports = {
  // Generic admin content (factory)
  contentRepo,
  // Public content reads
  listPublicTestimonials,
  listPublicFaq,
  listPublicCoursePreviews,
  // CompetitionPrize
  createCompetition,
  paginateCompetitions,
  findCompetitionLean,
  findCompetitionForWrite,
  findCompetitionScopedStatus,
  findCompetitionByIdLean,
  findCompetitionByIdForWrite,
  saveCompetitionDoc,
  deleteCompetition,
  findActiveCompetitionsBeforePeriod,
  findActivePublicCompetition,
  // QuizSession
  createQuizSession,
  findQuizSessionByToken,
  findQuizSessionForWriteByToken,
  saveQuizSessionDoc,
  findTopQuizSessions,
  findLeaderboardEntries,
  // QuizQuestion
  sampleQuizQuestions,
  findPublishedQuestionsWithAnswers,
  // ContactMessage
  createContactMessage,
};
