'use strict';

/**
 * @file teacherSchedule.model.js
 * @description Mongoose model for teacher-facing schedule sessions,
 *              availability, and workload management.
 *
 *  Alignements avec le backend foruni :
 *  ──────────────────────────────────────
 *  • Campus isolation : schoolCampus (ObjectId → 'Campus')
 *  • Teacher : ref 'Teacher' (teacher_model.js) — utilise _id du modèle Teacher
 *  • Subject : ref 'Subject' (subject_model.js)
 *  • Semester : 'S1' | 'S2' | 'Annual' (String)
 *  • ContractSnapshot aligné avec teacher_model.employmentType :
 *    'full-time' | 'part-time' | 'contract' | 'temporary'
 *  • Classes : ref 'Class' (class_model.js) et non groups
 *  • studentScheduleRef : lien vers StudentSchedule (même session)
 *  • JWT payload : req.user.id (et non req.user._id)
 */

const mongoose = require('mongoose');
const {
  SCHEDULE_STATUS,
  SESSION_TYPE,
  SEMESTER,
  RecurrenceSchema,
  RoomSchema,
  VirtualMeetingSchema,
  PostponementRequestSchema,
  WEEKDAY,
} = require('../../utils/schedule.base');

// ─────────────────────────────────────────────
// AVAILABILITY SUB-SCHEMA
// ─────────────────────────────────────────────

/**
 * Créneau de disponibilité hebdomadaire déclaré par l'enseignant.
 * Utilisé par le Campus Manager lors de la génération des emplois du temps.
 */
const AvailabilitySlotSchema = new mongoose.Schema(
  {
    day:         { type: String, enum: Object.values(WEEKDAY), required: true },
    startHour:   { type: Number, min: 0, max: 23, required: true },  // 0-23
    endHour:     { type: Number, min: 1, max: 24, required: true },  // 1-24
    isAvailable: { type: Boolean, default: true },   // false = créneau bloqué
    reason:      { type: String },                   // ex. "Recherche", "Médical"
    validFrom:   { type: Date },
    validUntil:  { type: Date },
  },
  { _id: true, timestamps: true }
);

// ─────────────────────────────────────────────
// WORKLOAD ENTRY SUB-SCHEMA
// ─────────────────────────────────────────────

/**
 * Snapshot de charge horaire par semaine/mois pour la paie.
 * Recalculé de façon asynchrone après chaque confirmation/annulation.
 */
const WorkloadPeriodSchema = new mongoose.Schema(
  {
    periodType:     { type: String, enum: ['WEEKLY', 'MONTHLY'], required: true },
    periodLabel:    { type: String, required: true },  // "2024-W42" ou "2024-10"
    scheduledHours: { type: Number, default: 0 },
    deliveredHours: { type: Number, default: 0 },
    cancelledHours: { type: Number, default: 0 },
    /** Quota contractuel au moment du snapshot */
    contractHours:  { type: Number, default: 0 },
    computedAt:     { type: Date, default: Date.now },
  },
  { _id: false }
);

// ─────────────────────────────────────────────
// ROLL-CALL STATUS SUB-SCHEMA
// ─────────────────────────────────────────────

const RollCallStatusSchema = new mongoose.Schema(
  {
    opened:      { type: Boolean, default: false },
    openedAt:    { type: Date },
    submitted:   { type: Boolean, default: false },
    submittedAt: { type: Date },
    totalPresent: { type: Number, default: 0 },
    totalAbsent:  { type: Number, default: 0 },
    totalLate:    { type: Number, default: 0 },
  },
  { _id: false }
);

// ─────────────────────────────────────────────
// CONTRACT SNAPSHOT SUB-SCHEMA
// ─────────────────────────────────────────────

/**
 * Snapshot contractuel aligné avec teacher_model.employmentType :
 * 'full-time' | 'part-time' | 'contract' | 'temporary'
 */
const ContractSnapshotSchema = new mongoose.Schema(
  {
    contractType:  {
      type: String,
      enum: ['full-time', 'part-time', 'contract', 'temporary'],
    },
    weeklyHours:   { type: Number },
    semesterHours: { type: Number },
    /** Taux horaire (XAF par défaut — cohérent avec le pays : Cameroun) */
    hourlyRate:    { type: Number },
    currency:      { type: String, default: 'XAF' },
  },
  { _id: false }
);

// ─────────────────────────────────────────────
// MAIN SCHEMA
// ─────────────────────────────────────────────

const TeacherScheduleSchema = new mongoose.Schema(
  {
    // ── IDENTIFICATION ──────────────────────
    // sparse: true — allows multiple documents with reference: null/undefined.
    // This is required because syncTeacherSchedule uses findOneAndUpdate (upsert),
    // which does NOT trigger pre('save') hooks, so `reference` may be null on
    // documents created before the $setOnInsert fix. Without sparse, MongoDB would
    // throw E11000 (duplicate key) on every upsert after the first null-reference doc.
    reference: {
      type:   String,
      unique: true,
      sparse: true,
      index:  true,
    },

    /**
     * Référence croisée vers le document StudentSchedule représentant
     * la même séance. Null pour les entrées de disponibilité pures.
     */
    studentScheduleRef: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'StudentSchedule',
      index:   true,
      default: null,
    },

    // ── LIFECYCLE ───────────────────────────
    status: {
      type:    String,
      enum:    Object.values(SCHEDULE_STATUS),
      default: SCHEDULE_STATUS.DRAFT,
      index:   true,
    },

    isOccurrence:  { type: Boolean, default: false },
    masterSession: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'TeacherSchedule',
      default: null,
    },
    originalStart: { type: Date },

    // ── CAMPUS ISOLATION ────────────────────
    schoolCampus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Campus',
      required: [true, 'Campus is required'],
      index:    true,
    },

    // ── TEACHER ─────────────────────────────
    teacher: {
      teacherId: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'Teacher',
        required: true,
        index:    true,
      },
      firstName:    { type: String },
      lastName:     { type: String },
      email:        { type: String },
      /** Matricule de l'enseignant (teacher_model.matricule) */
      matricule:    { type: String },
    },
    contract: { type: ContractSnapshotSchema, default: () => ({}) },

    // ── ACADEMIC CONTEXT ────────────────────
    academicYear: {
      type:  String,
      match: /^\d{4}-\d{4}$/,
    },
    /** Cohérent avec studentAttendance.model : 'S1' | 'S2' | 'Annual' */
    semester: {
      type: String,
      enum: Object.values(SEMESTER),
    },

    /** Matière enseignée — ref 'Subject' */
    subject: {
      subjectId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Subject' },
      subject_name: { type: String },
      subject_code: { type: String },
      department:   { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
    },

    sessionType: {
      type: String,
      enum: Object.values(SESSION_TYPE),
    },

    // ── TEMPORAL ────────────────────────────
    startTime:       { type: Date, required: true, index: true },
    endTime:         { type: Date, required: true },
    durationMinutes: { type: Number },

    // ── RECURRENCE ──────────────────────────
    recurrence: { type: RecurrenceSchema, default: () => ({}) },

    // ── CLASSES PARTICIPANTES ────────────────
    /** Ref 'Class' — cohérent avec class_model.js */
    classes: [
      {
        classId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Class' },
        className: { type: String },
      },
    ],

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

    // ── ROLL-CALL ───────────────────────────
    rollCall: { type: RollCallStatusSchema, default: () => ({}) },

    // ── POSTPONEMENT WORKFLOW ───────────────
    postponementRequests: [PostponementRequestSchema],

    // ── AVAILABILITY SLOTS ───────────────────
    /**
     * Créneaux de disponibilité déclarés par cet enseignant.
     * Embarqués ici pour éviter une collection séparée.
     * Réécrits en totalité à chaque mise à jour des préférences.
     */
    availabilitySlots: [AvailabilitySlotSchema],

    // ── WORKLOAD SNAPSHOTS ───────────────────
    workloadSnapshots: [WorkloadPeriodSchema],

    // ── PUBLICATION & AUDIT ──────────────────
    publishedAt:    { type: Date },
    publishedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },
    lastModifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },

    // ── SOFT-DELETE ──────────────────────────
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },
  },
  {
    timestamps:  true,
    collection:  'teacher_schedules',
    toJSON:      { virtuals: true },
    toObject:    { virtuals: true },
  }
);

// ─────────────────────────────────────────────
// COMPOUND INDEXES
// ─────────────────────────────────────────────

/** Détection de conflit enseignant */
TeacherScheduleSchema.index(
  { 'teacher.teacherId': 1, startTime: 1, endTime: 1, status: 1 },
  { name: 'idx_teacher_time_conflict' }
);
/** Agenda par enseignant / semestre */
TeacherScheduleSchema.index(
  { 'teacher.teacherId': 1, academicYear: 1, semester: 1, startTime: 1 },
  { name: 'idx_teacher_semester_calendar' }
);
/** Analytics charge horaire */
TeacherScheduleSchema.index(
  { 'teacher.teacherId': 1, 'workloadSnapshots.periodLabel': 1 },
  { name: 'idx_teacher_workload' }
);
/** Tableau de bord appel en attente */
TeacherScheduleSchema.index(
  { 'teacher.teacherId': 1, 'rollCall.submitted': 1, startTime: 1 },
  { name: 'idx_rollcall_pending' }
);
/** Campus global */
TeacherScheduleSchema.index(
  { schoolCampus: 1, startTime: 1, status: 1 },
  { name: 'idx_campus_teacher_calendar' }
);
/** Master → occurrences */
TeacherScheduleSchema.index(
  { masterSession: 1, startTime: 1 },
  { name: 'idx_master_occurrences' }
);

// ─────────────────────────────────────────────
// VIRTUAL FIELDS
// ─────────────────────────────────────────────

TeacherScheduleSchema.virtual('isPast').get(function () {
  return this.endTime < new Date();
});

TeacherScheduleSchema.virtual('isUpcoming').get(function () {
  return this.startTime > new Date();
});

TeacherScheduleSchema.virtual('isLive').get(function () {
  const now = new Date();
  return this.startTime <= now && this.endTime >= now;
});

TeacherScheduleSchema.virtual('latestWorkloadDeviation').get(function () {
  if (!this.workloadSnapshots || !this.workloadSnapshots.length) return null;
  const latest = this.workloadSnapshots[this.workloadSnapshots.length - 1];
  return latest.deliveredHours - latest.contractHours;
});

// ─────────────────────────────────────────────
// PRE-SAVE HOOKS
// ─────────────────────────────────────────────

TeacherScheduleSchema.pre('save', async function () {
  try {
    if (this.startTime && this.endTime) {
      this.durationMinutes = Math.round(
        (this.endTime - this.startTime) / 60000
      );
    }

    if (!this.reference) {
      const count = await mongoose.model('TeacherSchedule').countDocuments();
      this.reference = `TS-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`;
    }

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

/** Ouvre l'appel pour cette session */
TeacherScheduleSchema.methods.openRollCall = function () {
  if (this.rollCall.submitted) {
    throw new Error('Attendance has already been submitted for this session.');
  }
  this.rollCall.opened   = true;
  this.rollCall.openedAt = new Date();
  return this.save();
};

/**
 * Soumet et verrouille l'appel.
 * @param {{ present: number, absent: number, late: number }} counts
 */
TeacherScheduleSchema.methods.submitRollCall = function ({
  present = 0,
  absent  = 0,
  late    = 0,
} = {}) {
  this.rollCall.submitted    = true;
  this.rollCall.submittedAt  = new Date();
  this.rollCall.totalPresent = present;
  this.rollCall.totalAbsent  = absent;
  this.rollCall.totalLate    = late;
  return this.save();
};

/**
 * Ajoute ou met à jour un créneau de disponibilité.
 * @param {Object} slot – correspond au shape AvailabilitySlotSchema
 */
TeacherScheduleSchema.methods.upsertAvailability = function (slot) {
  const existing = this.availabilitySlots.id(slot._id);
  if (existing) {
    Object.assign(existing, slot);
  } else {
    this.availabilitySlots.push(slot);
  }
  return this.save();
};

// ─────────────────────────────────────────────
// STATIC METHODS
// ─────────────────────────────────────────────

/**
 * Détecte les conflits de planning sur l'axe enseignant.
 *
 * @param {Object}   params
 * @param {ObjectId} params.teacherId
 * @param {Date}     params.startTime
 * @param {Date}     params.endTime
 * @param {ObjectId} [params.excludeId]
 * @returns {Promise<{hasConflict: boolean, conflicts: Object[]}>}
 */
TeacherScheduleSchema.statics.detectTeacherConflicts = async function ({
  teacherId,
  startTime,
  endTime,
  excludeId = null,
}) {
  const filter = {
    'teacher.teacherId': teacherId,
    startTime:           { $lt: endTime },
    endTime:             { $gt: startTime },
    isDeleted:           false,
    status:              { $in: [SCHEDULE_STATUS.DRAFT, SCHEDULE_STATUS.PUBLISHED] },
  };

  if (excludeId) filter._id = { $ne: excludeId };

  const conflicts = await this.find(filter)
    .select('reference subject startTime endTime status room')
    .lean();

  return { hasConflict: conflicts.length > 0, conflicts };
};

/**
 * Retourne le calendrier de l'enseignant pour une plage de dates.
 *
 * @param {ObjectId} teacherId
 * @param {Date}     from
 * @param {Date}     to
 * @param {Object}   [options]
 * @param {boolean}  [options.includeAllStatuses=false]
 * @returns {Promise<Object[]>}
 */
TeacherScheduleSchema.statics.getTeacherCalendar = function (
  teacherId,
  from,
  to,
  { includeAllStatuses = false } = {}
) {
  const statusFilter = includeAllStatuses
    ? {}
    : { status: { $in: [SCHEDULE_STATUS.DRAFT, SCHEDULE_STATUS.PUBLISHED, SCHEDULE_STATUS.POSTPONED] } };

  // Ensure teacherId is always an ObjectId — callers may pass a string from JWT
  const tid = teacherId instanceof mongoose.Types.ObjectId
    ? teacherId
    : new mongoose.Types.ObjectId(String(teacherId));

  return this.find({
    'teacher.teacherId': tid,
    startTime:           { $gte: from },
    endTime:             { $lte: to },
    isDeleted:           false,
    ...statusFilter,
  })
    .sort({ startTime: 1 })
    .lean();
};

/**
 * Agrège les heures livrées vs contractuelles pour la paie.
 *
 * @param {ObjectId} teacherId
 * @param {string}   periodLabel  – "2024-10" ou "2024-W42"
 * @param {string}   periodType   – "WEEKLY" | "MONTHLY"
 * @returns {Promise<Object>}
 */
TeacherScheduleSchema.statics.getWorkloadSummary = async function (
  teacherId,
  periodLabel,
  periodType = 'MONTHLY'
) {
  const result = await this.aggregate([
    {
      $match: {
        'teacher.teacherId':             new mongoose.Types.ObjectId(teacherId),
        'workloadSnapshots.periodLabel': periodLabel,
        'workloadSnapshots.periodType':  periodType,
        isDeleted:                       false,
      },
    },
    { $unwind: '$workloadSnapshots' },
    {
      $match: {
        'workloadSnapshots.periodLabel': periodLabel,
        'workloadSnapshots.periodType':  periodType,
      },
    },
    {
      $group: {
        _id:                  null,
        totalScheduledHours:  { $sum: '$workloadSnapshots.scheduledHours' },
        totalDeliveredHours:  { $sum: '$workloadSnapshots.deliveredHours' },
        totalCancelledHours:  { $sum: '$workloadSnapshots.cancelledHours' },
        totalContractHours:   { $sum: '$workloadSnapshots.contractHours' },
      },
    },
  ]);

  return result[0] ?? {
    totalScheduledHours: 0,
    totalDeliveredHours: 0,
    totalCancelledHours: 0,
    totalContractHours:  0,
  };
};

/**
 * Vérifie si un créneau proposé entre en conflit avec les indisponibilités
 * déclarées par l'enseignant.
 *
 * @param {ObjectId} teacherId
 * @param {Date}     startTime (UTC)
 * @param {Date}     endTime   (UTC)
 * @returns {Promise<Object[]>} créneaux bloqués en conflit
 */
TeacherScheduleSchema.statics.checkAvailabilityConflict = async function (
  teacherId,
  startTime,
  endTime
) {
  const dayMap   = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const dayOfWeek  = dayMap[startTime.getDay()];
  const startHour  = startTime.getUTCHours() + startTime.getUTCMinutes() / 60;
  const endHour    = endTime.getUTCHours()   + endTime.getUTCMinutes()   / 60;

  const teacher = await this.findOne(
    { 'teacher.teacherId': teacherId, isDeleted: false },
    { availabilitySlots: 1 }
  ).lean();

  if (!teacher) return [];

  return (teacher.availabilitySlots || []).filter(
    (slot) =>
      !slot.isAvailable &&
      slot.day === dayOfWeek &&
      slot.startHour < endHour &&
      slot.endHour   > startHour
  );
};

// ─────────────────────────────────────────────
// JSON SERIALISATION
// ─────────────────────────────────────────────

TeacherScheduleSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    // Données salariales : exposées uniquement via l'endpoint dédié
    delete ret.contract;
    return ret;
  },
});

module.exports = mongoose.model('TeacherSchedule', TeacherScheduleSchema);