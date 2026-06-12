'use strict';

/**
 * @file schedule.base.js
 * @description Shared schema definitions, enums, and sub-schemas reused
 *              across studentSchedule and teacherSchedule models.
 *
 *  Aligné avec le backend foruni :
 *  ─────────────────────────────────────────────────────────────────────────
 *  • Semester     : 'S1' | 'S2' | 'Annual' (String)
 *  • Participants : Class (ref: 'Class') — pas de concept Group
 *  • Campus       : schoolCampus (ref: 'Campus') — isolation standard foruni
 *
 *  Décisions d'architecture (v2) :
 *  ─────────────────────────────────────────────────────────────────────────
 *  [A] SESSION_TYPE ne contient plus ONLINE.
 *      La modalité (présentiel / distanciel) est portée par le booléen `isVirtual`
 *      dans le schéma parent. Cela permet d'avoir un EXAM en ligne ou en salle
 *      sans ambiguïté de type pédagogique.
 *
 *  [B] PostponementRequestSchema.reviewedBy utilise un refPath dynamique
 *      (reviewedByModel : 'Teacher' | 'User') parce que les reports sont
 *      validés par ADMIN / CAMPUS_MANAGER, pas forcément par un Teacher.
 *
 *  [C] Les heures de début/fin sont stockées à la fois comme Date ISO (pour
 *      les requêtes de chevauchement sur des occurrences concrètes) ET comme
 *      entier "minutes depuis minuit" (startMinutes / endMinutes) pour les
 *      calculs de récurrence indépendants du fuseau horaire.
 *
 *  [Premium A] Champ `color` (hex string) pour le color-coding frontend.
 *  [Premium C] Champ `transitionMinutes` dans RoomSchema pour le temps de
 *              changement de salle entre deux sessions.
 *
 *  Note capacité (Premium B) : la validation StudentCount ≤ RoomCapacity est
 *  intentionnellement déléguée au contrôleur (createSession / updateSession)
 *  pour pouvoir renvoyer un message d'erreur HTTP précis et interroger le
 *  nombre d'étudiants de la Class en temps réel.
 */

const mongoose = require('mongoose');

// ─────────────────────────────────────────────
// ENUMS
// ─────────────────────────────────────────────

const SCHEDULE_STATUS = Object.freeze({
  DRAFT:     'DRAFT',
  PUBLISHED: 'PUBLISHED',
  CANCELLED: 'CANCELLED',
  POSTPONED: 'POSTPONED',
});

/**
 * [A] Type pédagogique de la session — ONLINE retiré.
 *     La modalité présentiel/distanciel est portée par `isVirtual` (Boolean)
 *     dans le schéma parent, ce qui permet d'orthogonaliser les deux axes :
 *       • type pédagogique : LECTURE, TD, TP, EXAM, WORKSHOP
 *       • modalité         : isVirtual true / false
 */
const SESSION_TYPE = Object.freeze({
  LECTURE:   'LECTURE',    // CM – Cours Magistral
  TUTORIAL:  'TUTORIAL',   // TD – Travaux Dirigés
  PRACTICAL: 'PRACTICAL',  // TP – Travaux Pratiques
  EXAM:      'EXAM',
  WORKSHOP:  'WORKSHOP',
});

const RECURRENCE_FREQUENCY = Object.freeze({
  NONE:    'NONE',
  DAILY:   'DAILY',
  WEEKLY:  'WEEKLY',
  MONTHLY: 'MONTHLY',
});

const WEEKDAY = Object.freeze({
  MO: 'MO', TU: 'TU', WE: 'WE',
  TH: 'TH', FR: 'FR', SA: 'SA', SU: 'SU',
});

/**
 * Valeurs de semestre alignées avec studentAttendance.model.js
 */
const SEMESTER = Object.freeze({
  S1:     'S1',
  S2:     'S2',
  ANNUAL: 'Annual',
});

/**
 * [Premium A] Palette de couleurs suggérées par type de session.
 * Le frontend peut écraser avec n'importe quelle valeur hex.
 * Ces constantes servent de valeurs par défaut / de référence UX.
 */
const SESSION_COLOR_DEFAULTS = Object.freeze({
  LECTURE:   '#3B82F6', // bleu
  TUTORIAL:  '#10B981', // vert
  PRACTICAL: '#F59E0B', // orange
  EXAM:      '#EF4444', // rouge
  WORKSHOP:  '#8B5CF6', // violet
});

// ─────────────────────────────────────────────
// SUB-SCHEMAS
// ─────────────────────────────────────────────

/**
 * RRule-compatible recurrence pattern.
 *
 * [C] byDay + interval/count/until restent inchangés (sémantique RRule).
 *     Les heures de début/fin de l'occurrence de base sont stockées dans
 *     le schéma parent via startMinutes / endMinutes (cf. note [C] en haut).
 */
const RecurrenceSchema = new mongoose.Schema(
  {
    frequency: {
      type:    String,
      enum:    Object.values(RECURRENCE_FREQUENCY),
      default: RECURRENCE_FREQUENCY.NONE,
    },
    /** ['MO', 'WE'] – significatif pour WEEKLY uniquement */
    byDay: [{ type: String, enum: Object.values(WEEKDAY) }],
    /** Nombre de répétitions (exclusif avec until) */
    count:    { type: Number, min: 1, max: 52 },
    /** Date de fin (UTC, exclusif avec count) */
    until:    { type: Date },
    /** Intervalle entre occurrences (défaut 1) */
    interval: { type: Number, default: 1, min: 1 },
    /**
     * Dates d'occurrence annulées ou remplacées par une exception.
     * Le frontend expanse la RRule et soustrait ces dates.
     */
    exceptionDates: [{ type: Date }],
  },
  { _id: false }
);

/**
 * Salle de cours avec métadonnées équipement.
 * Note : dans foruni, les salles ne sont pas encore un modèle dédié.
 *
 * [Premium C] transitionMinutes : temps tampon avant la prochaine session
 *             dans cette salle (ex: 10 min pour déplacer les étudiants).
 *             Utilisé par le détecteur de conflits pour appliquer un buffer
 *             réaliste entre deux sessions dans la même salle.
 */
const RoomSchema = new mongoose.Schema(
  {
    code:      { type: String, required: true },   // ex : "C-204"
    building:  { type: String },
    capacity:  { type: Number },                   // validé dans le contrôleur : StudentCount ≤ capacity
    equipment: [{ type: String }],                 // ['PROJECTOR', 'AC', 'LAB']
    /** Copie dénormalisée du Campus.campus_name pour les requêtes rapides */
    campusName:        { type: String },
    /** [Premium C] Durée minimale (en minutes) entre deux sessions dans cette salle */
    transitionMinutes: { type: Number, default: 10, min: 0 },
  },
  { _id: false }
);

/**
 * Métadonnées de réunion virtuelle (Zoom / Teams / Meet).
 * Utilisé uniquement si isVirtual === true sur le document parent.
 */
const VirtualMeetingSchema = new mongoose.Schema({
  platform:   { type: String, enum: ['ZOOM', 'TEAMS', 'MEET', 'OTHER'] },
  meetingUrl: { type: String },  // ← aligné avec frontend + Yup + controller
  meetingId:  { type: String },
  passcode:   { type: String },
}, { _id: false });

/**
 * Référence vers un document de cours (support pédagogique).
 */
const CourseMaterialSchema = new mongoose.Schema(
  {
    title:      { type: String, required: true },
    url:        { type: String, required: true },
    mimeType:   { type: String },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

/**
 * Workflow de report / annulation de séance.
 *
 * [B] reviewedBy utilise un refPath dynamique :
 *     • reviewedByModel peut valoir 'Teacher' ou 'User' selon qui a validé.
 *     • Cela couvre les rôles ADMIN et CAMPUS_MANAGER (collection 'users'
 *       dans foruni) ainsi que les enseignants-coordinateurs si besoin.
 *     • requestedBy reste ref: 'Teacher' car seul un enseignant soumet
 *       une demande de report.
 */
const PostponementRequestSchema = new mongoose.Schema(
  {
    requestedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', required: true },
    requestedAt:   { type: Date, default: Date.now },
    reason:        { type: String, required: true },
    proposedStart: { type: Date },
    proposedEnd:   { type: Date },
    status: {
      type:    String,
      enum:    ['PENDING', 'APPROVED', 'REJECTED'],
      default: 'PENDING',
    },
    /**
     * [B] Discriminant pour le refPath : 'User' = ADMIN / CAMPUS_MANAGER,
     *     'Teacher' = enseignant-coordinateur habilité.
     *     Par défaut 'User' car c'est le cas le plus fréquent.
     */
    reviewedByModel: {
      type:    String,
      enum:    ['Teacher', 'User'],
      default: 'User',
    },
    reviewedBy: {
      type:    mongoose.Schema.Types.ObjectId,
      refPath: 'postponementRequests.reviewedByModel',
    },
    reviewedAt: { type: Date },
    reviewNote: { type: String },
  },
  { _id: true, timestamps: true }
);

// ─────────────────────────────────────────────
// RÉFÉRENCE : CHAMPS À AJOUTER DANS LES SCHÉMAS PARENTS
// ─────────────────────────────────────────────

/**
 * Ces champs doivent être présents dans chaque schéma parent
 * (StudentSchedule, TeacherSchedule) qui étend schedule.base.
 *
 * [A]  isVirtual : Boolean, default false
 *          → true  = session en ligne (VirtualMeetingSchema requis)
 *          → false = session en présentiel (RoomSchema requis)
 *
 * [C]  startMinutes : Number (0–1439)   ex : 480  pour 08:00
 *      endMinutes   : Number (0–1439)   ex : 600  pour 10:00
 *          → calculs de récurrence sans dépendance TZ
 *          → startTime / endTime (Date ISO) restent pour les requêtes
 *            de chevauchement sur des occurrences concrètes
 *
 * [Premium A]  color : String (hex, ex : '#EF4444')
 *          → valeur par défaut recommendée : SESSION_COLOR_DEFAULTS[sessionType]
 *
 * Exemple d'intégration :
 * ──────────────────────
 *   sessionType  : { type: String, enum: Object.values(SESSION_TYPE), required: true },
 *   isVirtual    : { type: Boolean, default: false },
 *   startTime    : { type: Date, required: true },
 *   endTime      : { type: Date, required: true },
 *   startMinutes : { type: Number, min: 0, max: 1439 },
 *   endMinutes   : { type: Number, min: 0, max: 1439 },
 *   color        : { type: String, match: /^#[0-9A-Fa-f]{6}$/ },
 *   room         : RoomSchema,            // si isVirtual === false
 *   virtualMeeting: VirtualMeetingSchema, // si isVirtual === true
 */

// ─────────────────────────────────────────────
// UTILITAIRES DE DÉTECTION DE CONFLITS
// ─────────────────────────────────────────────

/**
 * Vérifie si [startA, endA[ chevauche [startB, endB[.
 * Fonctionne avec des objets Date ou des entiers (minutes depuis minuit).
 *
 * @param {Date|number} startA
 * @param {Date|number} endA
 * @param {Date|number} startB
 * @param {Date|number} endB
 * @returns {boolean}
 */
const timeRangesOverlap = (startA, endA, startB, endB) =>
  startA < endB && endA > startB;

/**
 * [Premium C] Vérifie si deux sessions dans la MÊME salle ne respectent
 * pas le temps de transition minimal défini par RoomSchema.transitionMinutes.
 *
 * @param {Date|number} endA          - Fin de la session A
 * @param {Date|number} startB        - Début de la session B (postérieure)
 * @param {number}      transitionMin - transitionMinutes de la salle (défaut 10)
 * @returns {boolean} true = conflit (pas assez de temps entre les deux)
 */
const hasRoomTransitionConflict = (endA, startB, transitionMin = 10) => {
  const toMs = (v) => (v instanceof Date ? v.getTime() : v * 60000);
  return (toMs(startB) - toMs(endA)) < transitionMin * 60000;
};

/**
 * [C] Convertit une heure "HH:mm" en minutes depuis minuit.
 * @param {string} hhmm  ex : "08:30"
 * @returns {number}     ex : 510
 */
const hhmmToMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};

/**
 * [C] Convertit un entier "minutes depuis minuit" en string "HH:mm".
 * @param {number} minutes  ex : 510
 * @returns {string}        ex : "08:30"
 */
const minutesToHhmm = (minutes) => {
  const h = Math.floor(minutes / 60).toString().padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
};

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  // Enums
  SCHEDULE_STATUS,
  SESSION_TYPE,
  SESSION_COLOR_DEFAULTS,
  RECURRENCE_FREQUENCY,
  WEEKDAY,
  SEMESTER,

  // Sub-schemas
  RecurrenceSchema,
  RoomSchema,
  VirtualMeetingSchema,
  CourseMaterialSchema,
  PostponementRequestSchema,

  // Utilitaires
  timeRangesOverlap,
  hasRoomTransitionConflict,
  hhmmToMinutes,
  minutesToHhmm,
};