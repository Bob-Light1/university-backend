'use strict';

/**
 * @file public-portal.repository.js — couche d'accès aux données du module public-portal.
 *
 * SEUL fichier autorisé à toucher les 7 models possédés :
 *   - CompetitionPrize (competition.prize.model)
 *   - ContactMessage   (contact.message.model)
 *   - CoursePreview    (course.preview.model)
 *   - FaqEntry         (faq.entry.model)
 *   - QuizQuestion     (quiz.question.model)
 *   - QuizSession      (quiz.session.model)
 *   - Testimonial      (testimonial.model)
 *
 * Consommateurs : controllers publics (quiz/leaderboard/témoignages/faq/cours/
 * contact/compétition), back-office portal-admin (factory de contenu générique +
 * competition.admin), cron de clôture mensuelle et service de notification des
 * gagnants. Tous passent exclusivement par lui.
 *
 * Conventions :
 *   - Lectures → objets simples (`.lean()`) ; les formes de requête (select,
 *     sort, $sample/$project) vivent ICI.
 *   - Écritures à hook (validations de schéma, génération de période/score) via
 *     create() ou load→mutate→save (findXxxForWrite + saveXxxDoc).
 *   - Les filtres d'isolation campus / périmètre et les `$in` castés en ObjectId
 *     sont construits par l'appelant et passés tels quels.
 *   - La factory de contenu admin (Testimonial/FaqEntry/CoursePreview partagent
 *     la même forme) consomme une *content-repo* liée au model via
 *     `contentRepo(name)` — la factory ne touche plus aucun model directement.
 *
 * Exceptions assumées (restent hors repo) :
 *   - Cast/validation d'ObjectId (mongoose.Types.ObjectId) : dans les controllers
 *     qui construisent les filtres.
 *   - Logique métier (calcul de score, classement, période courante, anonymisation
 *     des gagnants, envoi email/SMS) : reste dans controllers / cron / notification.
 */

const CompetitionPrize = require('./models/competition.prize.model');
const ContactMessage   = require('./models/contact.message.model');
const CoursePreview    = require('./models/course.preview.model');
const FaqEntry         = require('./models/faq.entry.model');
const QuizQuestion     = require('./models/quiz.question.model');
const QuizSession      = require('./models/quiz.session.model');
const Testimonial      = require('./models/testimonial.model');

// ─────────────────────────────────────────────────────────────────────────────
// CONTENU GÉNÉRIQUE ADMIN (Testimonial / FaqEntry / CoursePreview)
// ─────────────────────────────────────────────────────────────────────────────

/** Tri commun des ressources de contenu (ordre manuel puis récence). */
const CONTENT_SORT = { order: 1, createdAt: -1 };

/**
 * Construit une content-repo liée à un model donné — six opérations CRUD
 * consommées par la factory `makeContentController`. La factory n'a ainsi jamais
 * de référence directe à un model.
 */
const makeContentRepo = (Model) => ({
  /** Crée une ressource de contenu (déclenche la validation de schéma). */
  create: (doc) => Model.create(doc),

  /** Liste paginée + compteur, tri contenu. Renvoie { data, total }. */
  paginate: async (filter, { skip, limit }) => {
    const [data, total] = await Promise.all([
      Model.find(filter).sort(CONTENT_SORT).skip(skip).limit(limit).lean(),
      Model.countDocuments(filter),
    ]);
    return { data, total };
  },

  /** Lecture lean scopée (getOne). */
  findOneLean: (filter) => Model.findOne(filter).lean(),

  /** Doc non-lean scopé pour écriture (update / togglePublish). */
  findOneForWrite: (filter) => Model.findOne(filter),

  /** Persiste un doc de contenu (déclenche les hooks de save). */
  save: (doc) => doc.save(),

  /** Suppression scopée (remove). */
  findOneAndDelete: (filter) => Model.findOneAndDelete(filter),
});

const CONTENT_REPOS = {
  Testimonial:   makeContentRepo(Testimonial),
  FaqEntry:      makeContentRepo(FaqEntry),
  CoursePreview: makeContentRepo(CoursePreview),
};

/** Renvoie la content-repo liée au model nommé (consommée par les routes admin). */
const contentRepo = (name) => {
  const r = CONTENT_REPOS[name];
  if (!r) throw new Error(`Unknown public-portal content model: ${name}`);
  return r;
};

// ─────────────────────────────────────────────────────────────────────────────
// LECTURES PUBLIQUES DE CONTENU (sélections restreintes au portail)
// ─────────────────────────────────────────────────────────────────────────────

/** Témoignages publiés d'un campus (filtre fourni), tri contenu, lean. */
const listPublicTestimonials = (filter, limit) =>
  Testimonial.find(filter)
    .sort(CONTENT_SORT)
    .limit(limit)
    .select('firstName city graduationYear program quote photoUrl employer')
    .lean();

/** Entrées FAQ publiées d'un campus (filtre fourni), tri contenu, lean. */
const listPublicFaq = (filter) =>
  FaqEntry.find(filter)
    .sort(CONTENT_SORT)
    .select('question answer category')
    .lean();

/** Aperçus de cours publiés d'un campus (filtre fourni), tri contenu, lean. */
const listPublicCoursePreviews = (filter) =>
  CoursePreview.find(filter)
    .sort(CONTENT_SORT)
    .select('program title content videoUrl')
    .lean();

// ─────────────────────────────────────────────────────────────────────────────
// COMPETITION PRIZE
// ─────────────────────────────────────────────────────────────────────────────

/** Crée une compétition (unicité campus+période en index). */
const createCompetition = (doc) => CompetitionPrize.create(doc);

/** Liste paginée des compétitions (filtre fourni), tri période desc → { data, total }. */
const paginateCompetitions = async (filter, { skip, limit }) => {
  const [data, total] = await Promise.all([
    CompetitionPrize.find(filter).sort({ period: -1 }).skip(skip).limit(limit).lean(),
    CompetitionPrize.countDocuments(filter),
  ]);
  return { data, total };
};

/** Compétition scopée, lecture lean (getOne admin). */
const findCompetitionLean = (filter) => CompetitionPrize.findOne(filter).lean();

/** Compétition scopée non-lean pour écriture (update / toggleActive). */
const findCompetitionForWrite = (filter) => CompetitionPrize.findOne(filter);

/** Garde de périmètre avant clôture immédiate (statut seul). */
const findCompetitionScopedStatus = (filter) =>
  CompetitionPrize.findOne(filter).select('_id isActive');

/** Compétition par id, lecture lean (état figé après clôture). */
const findCompetitionByIdLean = (id) => CompetitionPrize.findById(id).lean();

/** Compétition par id non-lean pour écriture (clôture par le cron : winners[]+save). */
const findCompetitionByIdForWrite = (id) => CompetitionPrize.findById(id);

/** Persiste un doc compétition (winners figés, notifiedAt). */
const saveCompetitionDoc = (doc) => doc.save();

/** Suppression scopée d'une compétition (remove admin). */
const deleteCompetition = (filter) => CompetitionPrize.findOneAndDelete(filter);

/** Compétitions actives dont la période est strictement antérieure (cron, lean). */
const findActiveCompetitionsBeforePeriod = (period) =>
  CompetitionPrize.find({ isActive: true, period: { $lt: period } })
    .select('_id')
    .lean();

/** Compétition active la plus récente d'un campus (filtre fourni), vue publique. */
const findActivePublicCompetition = (filter) =>
  CompetitionPrize.findOne(filter)
    .sort({ period: -1 })
    .select('period prizes closingDate winners')
    .lean();

// ─────────────────────────────────────────────────────────────────────────────
// QUIZ SESSION
// ─────────────────────────────────────────────────────────────────────────────

/** Crée une session de quiz soumise (validation du score en pre-save). */
const createQuizSession = (payload) => QuizSession.create(payload);

/** Session par token de soumission (anti-double-soumission), lean. */
const findQuizSessionByToken = (sessionToken) =>
  QuizSession.findOne({ sessionToken }).lean();

/**
 * Meilleures sessions complétées d'une période/campus (clôture cron).
 * Tri meilleur score puis plus rapide ; sélection minimale pour figer winners[].
 */
const findTopQuizSessions = ({ schoolCampus, period }, limit) =>
  QuizSession.find({ schoolCampus, period, completedAt: { $ne: null } })
    .sort({ score: -1, completedAt: 1 })
    .limit(limit)
    .select('_id lead displayName score')
    .lean();

/**
 * Classement public d'une période (filtre de périmètre fourni : campus/national +
 * catégorie). Tri meilleur score puis plus rapide ; aucune donnée personnelle.
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
 * Échantillon aléatoire de questions publiées (filtre fourni). `$sample` ne
 * respecte pas `select:false` → liste blanche explicite via `$project`
 * (correctIndex et champs internes jamais exposés).
 */
const sampleQuizQuestions = (matchFilter, size) =>
  QuizQuestion.aggregate([
    { $match: matchFilter },
    { $sample: { size } },
    { $project: { _id: 1, text: 1, options: 1, category: 1, difficulty: 1, lang: 1 } },
  ]);

/**
 * Questions publiées d'un campus pour le calcul de score (filtre fourni avec ids
 * castés). `+correctIndex` force l'inclusion du champ `select:false` côté ERP.
 */
const findPublishedQuestionsWithAnswers = (filter) =>
  QuizQuestion.find(filter).select('+correctIndex').lean();

// ─────────────────────────────────────────────────────────────────────────────
// CONTACT MESSAGE
// ─────────────────────────────────────────────────────────────────────────────

/** Crée un message de contact (formulaire public). */
const createContactMessage = (payload) => ContactMessage.create(payload);

module.exports = {
  // Contenu générique admin (factory)
  contentRepo,
  // Lectures publiques de contenu
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
  findTopQuizSessions,
  findLeaderboardEntries,
  // QuizQuestion
  sampleQuizQuestions,
  findPublishedQuestionsWithAnswers,
  // ContactMessage
  createContactMessage,
};
