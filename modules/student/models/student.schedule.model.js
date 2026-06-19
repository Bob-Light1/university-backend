'use strict';

/**
 * @file student.schedule.model.js
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
} = require('../../../shared/utils/schedule.base');

// ─────────────────────────────────────────────
// ATTENDANCE SUMMARY SUB-SCHEMA
// ─────────────────────────────────────────────

const AttendanceSummarySchema = new mongoose.Schema(
  {
    present:  { type: Number, default: 0 },
    absent:   { type: Number, default: 0 },
    late:     { type: Number, default: 0 },
    /** 0–100 % updated after each attendance entry */
    rate:     { type: Number, default: null, min: 0, max: 100 },
    /** Has the attendance sheet been submitted (locked)? */
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
    /** Auto-generated human-readable reference (e.g. "SS-2025-00042") */
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

    /** Master recurrence document (if materialized occurrence) */
    isOccurrence:  { type: Boolean, default: false },
    masterSession: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'StudentSchedule',
      default: null,
    },
    /** Original start time before a postponement (UTC) */
    originalStart: { type: Date },

    // ── CAMPUS ISOLATION ────────────────────
    /** Required: consistent with student_model, teacher_model, class_model */
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
    /** Consistent with studentAttendance.model: 'S1' | 'S2' | 'Annual' */
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
    /** All dates in UTC; TZ conversion on the client side. */
    startTime:       { type: Date, required: true, index: true },
    endTime:         { type: Date, required: true },
    /** Denormalized for fast aggregations */
    durationMinutes: { type: Number },

    // ── RECURRENCE ──────────────────────────
    recurrence: { type: RecurrenceSchema, default: () => ({}) },

    // ── PARTICIPANTS ────────────────────────
    /**
     * Assigned teacher — ref 'Teacher' (teacher_model.js).
     * firstName/lastName/email are denormalized to avoid frequent joins.
     */
    teacher: {
      teacherId: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', required: true },
      firstName: { type: String },
      lastName:  { type: String },
      email:     { type: String },
    },

    /**
     * Participating classes — ref 'Class' (class_model.js).
     * A session can host several merged classes (grouped labs).
     * Class already contains the student list (students[]).
     */
    classes: [
      {
        classId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
        className: { type: String },
        level:     { type: mongoose.Schema.Types.ObjectId, ref: 'Level' },
      },
    ],

    /** Total expected headcount (sum of enrollees across classes) */
    expectedAttendees: { type: Number },

    // ── LOCATION ────────────────────────────
    /**
     * [A] isVirtual decouples delivery mode from pedagogical type.
     *     true  → online session  (virtualMeeting required, room optional)
     *     false → in-person session (room required)
     *     Consistent with schedule.base.js decision [A] and VirtualMeetingSchema.
     */
    isVirtual:      { type: Boolean, default: false },
    room:           { type: RoomSchema },
    virtualMeeting: { type: VirtualMeetingSchema },

    // ── CONTENT ─────────────────────────────
    topic:       { type: String },
    description: { type: String },
    materials:   [CourseMaterialSchema],

    // ── ATTENDANCE SUMMARY ──────────────────
    /** Denormalized summary updated by the attendance controller */
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

/** Prevents double-booking a class on the same time slot */
StudentScheduleSchema.index(
  { 'classes.classId': 1, startTime: 1, endTime: 1, status: 1 },
  { name: 'idx_class_time_conflict' }
);
/** Prevents double-booking a room */
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
    // Automatic duration calculation
    if (this.startTime && this.endTime) {
      this.durationMinutes = Math.round(
        (this.endTime - this.startTime) / 60000
      );
    }

    // Auto-generate the unique reference
    if (!this.reference) {
      const count = await mongoose.model('StudentSchedule').countDocuments();
      this.reference = `SS-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`;
    }

    // Publication timestamp
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

/** Returns whether the session is visible to students */
StudentScheduleSchema.methods.isVisibleToStudents = function () {
  return (
    this.status === SCHEDULE_STATUS.PUBLISHED &&
    !this.isDeleted &&
    this.status !== SCHEDULE_STATUS.CANCELLED
  );
};

/**
 * Cancels the session and records who did it.
 * @param {ObjectId} userId  – teacher or manager ID
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
 * Detects scheduling conflicts for a proposed time slot.
 * Checks: class already occupied AND/OR room already booked.
 *
 * @param {Object}     params
 * @param {Date}       params.startTime
 * @param {Date}       params.endTime
 * @param {ObjectId}   params.schoolCampus
 * @param {string}     [params.roomCode]
 * @param {ObjectId[]} [params.classIds]
 * @param {ObjectId}   [params.excludeId]    – exclude the session currently being updated
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
 * Fetches the personal calendar for a student.
 *
 * @param {ObjectId}   classId   – student's class (studentClass)
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