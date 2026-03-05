'use strict';

/**
 * @file studentSchedule.model.js
 * @description Mongoose model for student-facing schedule sessions.
 */

const mongoose = require('mongoose');
const {
  SCHEDULE_STATUS,
  SESSION_TYPE,
  SEMESTER,
  RecurrenceSchema,
  RoomSchema,
  VirtualMeetingSchema,
  CourseMaterialSchema,
  PostponementRequestSchema,
} = require('../utils/schedule.base');

// ─────────────────────────────────────────────
// ATTENDANCE SUMMARY SUB-SCHEMA
// ─────────────────────────────────────────────

const AttendanceSummarySchema = new mongoose.Schema(
  {
    present:  { type: Number, default: 0 },
    absent:   { type: Number, default: 0 },
    late:     { type: Number, default: 0 },
    /** 0–100 % mis à jour après chaque saisie de présence */
    rate:     { type: Number, default: null, min: 0, max: 100 },
    /** Le relevé de présence a-t-il été soumis (verrouillé) ? */
    closed:   { type: Boolean, default: false },
    closedAt: { type: Date },
  },
  { _id: false }
);

// ─────────────────────────────────────────────
// MAIN SCHEMA
// ─────────────────────────────────────────────

const StudentScheduleSchema = new mongoose.Schema(
  {
    // ── IDENTIFICATION ──────────────────────
    /** Référence lisible auto-générée (ex. "SS-2025-00042") */
    reference: {
      type:  String,
      unique: true,
      index:  true,
    },

    // ── LIFECYCLE ───────────────────────────
    status: {
      type:    String,
      enum:    Object.values(SCHEDULE_STATUS),
      default: SCHEDULE_STATUS.DRAFT,
      index:   true,
    },

    /** Document de récurrence maître (si occurrence matérialisée) */
    isOccurrence:  { type: Boolean, default: false },
    masterSession: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'StudentSchedule',
      default: null,
    },
    /** Heure de début originale avant un report (UTC) */
    originalStart: { type: Date },

    // ── CAMPUS ISOLATION ────────────────────
    /** Obligatoire : cohérent avec student_model, teacher_model, class_model */
    schoolCampus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Campus',
      required: [true, 'Campus is required'],
      index:    true,
    },

    // ── ACADEMIC CONTEXT ────────────────────
    academicYear: {
      type:     String,
      required: true,
      match:    /^\d{4}-\d{4}$/,  // "2024-2025"
    },
    /** Cohérent avec studentAttendance.model : 'S1' | 'S2' | 'Annual' */
    semester: {
      type:     String,
      required: true,
      enum:     Object.values(SEMESTER),
    },

    /**
     * Matière enseignée.
     * Ref vers Subject (subject_model.js) : champ subject_name, subject_code.
     */
    subject: {
      subjectId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', required: true },
      subject_name: { type: String, required: true },
      subject_code: { type: String },
      coefficient:  { type: Number },
      department:   { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
    },

    sessionType: {
      type:     String,
      enum:     Object.values(SESSION_TYPE),
      required: true,
    },

    // ── TEMPORAL ────────────────────────────
    /** Toutes les dates en UTC ; conversion TZ côté client. */
    startTime:       { type: Date, required: true, index: true },
    endTime:         { type: Date, required: true },
    /** Dénormalisé pour les agrégations rapides */
    durationMinutes: { type: Number },

    // ── RECURRENCE ──────────────────────────
    recurrence: { type: RecurrenceSchema, default: () => ({}) },

    // ── PARTICIPANTS ────────────────────────
    /**
     * Enseignant assigné — ref 'Teacher' (teacher_model.js du projet).
     * On dénormalise firstName/lastName/email pour éviter les joins fréquents.
     */
    teacher: {
      teacherId: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', required: true },
      firstName: { type: String },
      lastName:  { type: String },
      email:     { type: String },
    },

    /**
     * Classes participantes — ref 'Class' (class_model.js du projet).
     * Une session peut accueillir plusieurs classes fusionnées (TD regroupés).
     * La Class contient déjà la liste des étudiants (students[]).
     */
    classes: [
      {
        classId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
        className: { type: String },
        level:     { type: mongoose.Schema.Types.ObjectId, ref: 'Level' },
      },
    ],

    /** Effectif total attendu (somme des inscrits dans les classes) */
    expectedAttendees: { type: Number },

    // ── LOCATION ────────────────────────────
    /**
     * [A] isVirtual découple la modalité du type pédagogique.
     *     true  → session en ligne  (virtualMeeting requis, room optionnel)
     *     false → session en présentiel (room requis)
     *     Cohérent avec schedule.base.js décision [A] et VirtualMeetingSchema.
     */
    isVirtual:      { type: Boolean, default: false },
    room:           { type: RoomSchema },
    virtualMeeting: { type: VirtualMeetingSchema },

    // ── CONTENT ─────────────────────────────
    topic:       { type: String },
    description: { type: String },
    materials:   [CourseMaterialSchema],

    // ── ATTENDANCE SUMMARY ──────────────────
    /** Résumé dénormalisé mis à jour par le contrôleur d'attendance */
    attendance: { type: AttendanceSummarySchema, default: () => ({}) },

    // ── POSTPONEMENT WORKFLOW ───────────────
    postponementRequests: [PostponementRequestSchema],

    // ── PUBLICATION & AUDIT ─────────────────
    publishedAt:    { type: Date },
    publishedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },
    lastModifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },

    // ── SOFT-DELETE ─────────────────────────
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },
  },
  {
    timestamps:  true,           // createdAt, updatedAt
    collection:  'student_schedules',
    toJSON:      { virtuals: true },
    toObject:    { virtuals: true },
  }
);

// ─────────────────────────────────────────────
// COMPOUND INDEXES — conflict detection & queries
// ─────────────────────────────────────────────

/** Empêche le double-booking d'une classe sur le même créneau */
StudentScheduleSchema.index(
  { 'classes.classId': 1, startTime: 1, endTime: 1, status: 1 },
  { name: 'idx_class_time_conflict' }
);
/** Empêche le double-booking d'une salle */
StudentScheduleSchema.index(
  { 'room.code': 1, schoolCampus: 1, startTime: 1, endTime: 1, status: 1 },
  { name: 'idx_room_time_conflict' }
);
/** Agenda par enseignant */
StudentScheduleSchema.index(
  { 'teacher.teacherId': 1, startTime: 1, status: 1 },
  { name: 'idx_teacher_calendar' }
);
/** Vue globale par campus */
StudentScheduleSchema.index(
  { schoolCampus: 1, startTime: 1, status: 1 },
  { name: 'idx_campus_calendar' }
);
/** Navigation master → occurrences */
StudentScheduleSchema.index(
  { masterSession: 1, startTime: 1 },
  { name: 'idx_master_occurrences' }
);

// ─────────────────────────────────────────────
// VIRTUAL FIELDS
// ─────────────────────────────────────────────

StudentScheduleSchema.virtual('isPast').get(function () {
  return this.endTime < new Date();
});

StudentScheduleSchema.virtual('isUpcoming').get(function () {
  return this.startTime > new Date();
});

StudentScheduleSchema.virtual('isLive').get(function () {
  const now = new Date();
  return this.startTime <= now && this.endTime >= now;
});

// ─────────────────────────────────────────────
// PRE-SAVE HOOKS
// ─────────────────────────────────────────────

StudentScheduleSchema.pre('save', async function (next) {
  try {
    // Calcul automatique de la durée
    if (this.startTime && this.endTime) {
      this.durationMinutes = Math.round(
        (this.endTime - this.startTime) / 60000
      );
    }

    // Auto-génération de la référence unique
    if (!this.reference) {
      const count = await mongoose.model('StudentSchedule').countDocuments();
      this.reference = `SS-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`;
    }

    // Horodatage de publication
    if (
      this.isModified('status') &&
      this.status === SCHEDULE_STATUS.PUBLISHED &&
      !this.publishedAt
    ) {
      this.publishedAt = new Date();
    }
  } catch (err) {
    throw err;
  }
});

// ─────────────────────────────────────────────
// INSTANCE METHODS
// ─────────────────────────────────────────────

/** Indique si la session est visible par les étudiants */
StudentScheduleSchema.methods.isVisibleToStudents = function () {
  return (
    this.status === SCHEDULE_STATUS.PUBLISHED &&
    !this.isDeleted &&
    this.status !== SCHEDULE_STATUS.CANCELLED
  );
};

/**
 * Annule la session et enregistre qui l'a fait.
 * @param {ObjectId} userId  – ID de l'enseignant ou du gestionnaire
 * @param {string}   reason
 */
StudentScheduleSchema.methods.cancel = function (userId, reason = '') {
  this.status = SCHEDULE_STATUS.CANCELLED;
  this.lastModifiedBy = userId;
  if (reason) this.description = `[CANCELLED] ${reason}`;
  return this.save();
};

// ─────────────────────────────────────────────
// STATIC METHODS
// ─────────────────────────────────────────────

/**
 * Détecte les conflits de planning pour un créneau proposé.
 * Vérifie : classe déjà occupée ET/OU salle déjà réservée.
 *
 * @param {Object}     params
 * @param {Date}       params.startTime
 * @param {Date}       params.endTime
 * @param {ObjectId}   params.schoolCampus
 * @param {string}     [params.roomCode]
 * @param {ObjectId[]} [params.classIds]
 * @param {ObjectId}   [params.excludeId]    – exclure la session en cours d'update
 * @returns {Promise<{hasConflict: boolean, conflicts: Object[]}>}
 */
StudentScheduleSchema.statics.detectConflicts = async function ({
  startTime,
  endTime,
  schoolCampus,
  roomCode,
  classIds = [],
  excludeId = null,
}) {
  const baseFilter = {
    schoolCampus,
    startTime: { $lt: endTime },
    endTime:   { $gt: startTime },
    isDeleted: false,
    status:    { $in: [SCHEDULE_STATUS.DRAFT, SCHEDULE_STATUS.PUBLISHED] },
  };

  if (excludeId) baseFilter._id = { $ne: excludeId };

  const orClauses = [];
  if (roomCode)           orClauses.push({ 'room.code': roomCode });
  if (classIds.length > 0) orClauses.push({ 'classes.classId': { $in: classIds } });

  if (orClauses.length === 0) return { hasConflict: false, conflicts: [] };

  const conflicts = await this.find({ ...baseFilter, $or: orClauses })
    .select('reference subject room classes startTime endTime status teacher')
    .lean();

  return { hasConflict: conflicts.length > 0, conflicts };
};

/**
 * Récupère le calendrier personnel d'un étudiant.
 *
 * @param {ObjectId}   classId   – classe de l'étudiant (studentClass)
 * @param {ObjectId}   campusId
 * @param {Date}       from
 * @param {Date}       to
 * @returns {Promise<Object[]>}
 */
StudentScheduleSchema.statics.getStudentCalendar = function (
  classId,
  campusId,
  from,
  to
) {
  return this.find({
    'classes.classId': classId,
    schoolCampus:      campusId,
    startTime:         { $gte: from },
    endTime:           { $lte: to },
    status:            SCHEDULE_STATUS.PUBLISHED,
    isDeleted:         false,
  })
    .sort({ startTime: 1 })
    .lean();
};

// ─────────────────────────────────────────────
// JSON SERIALISATION
// ─────────────────────────────────────────────

StudentScheduleSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('StudentSchedule', StudentScheduleSchema);