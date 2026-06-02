'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

const {
  WEEKDAY,
  SEMESTER,
  SESSION_TYPE,
} = require('../utils/schedule.base');

// ─────────────────────────────────────────────
// GAET STATUS
// ─────────────────────────────────────────────

const GAET_STATUS = Object.freeze({
  DRAFT:               'DRAFT',
  GENERATING:          'GENERATING',
  GENERATED:           'GENERATED',
  PARTIALLY_GENERATED: 'PARTIALLY_GENERATED',
  PUBLISHED:           'PUBLISHED',
  FAILED:              'FAILED',
  CANCELLED:           'CANCELLED',
});

// ─────────────────────────────────────────────
// ROOM TYPE
// ─────────────────────────────────────────────

const ROOM_TYPE = Object.freeze({
  CLASSROOM:    'CLASSROOM',
  LAB:          'LAB',
  AMPHITHEATER: 'AMPHITHEATER',
});

// ─────────────────────────────────────────────
// SUB-SCHEMAS — INPUT (constraints)
// ─────────────────────────────────────────────

// A time slot on the weekly grid (e.g. Monday 08:00–10:00)
const TimeSlotSchema = new Schema(
  {
    day:       { type: String, enum: Object.values(WEEKDAY), required: true },
    startHour: { type: Number, min: 0, max: 23, required: true },
    endHour:   { type: Number, min: 1, max: 24, required: true },
    isBreak:   { type: Boolean, default: false },
  },
  { _id: false }
);

// One slot where a teacher is unavailable (same structure as TimeSlot without isBreak)
const UnavailableSlotSchema = new Schema(
  {
    day:       { type: String, enum: Object.values(WEEKDAY), required: true },
    startHour: { type: Number, min: 0, max: 23, required: true },
    endHour:   { type: Number, min: 1, max: 24, required: true },
  },
  { _id: false }
);

// Soft constraints per teacher (preferences only — hard unavailability via unavailableSlots)
const TeacherPreferenceSchema = new Schema(
  {
    teacherId:          { type: ObjectId, ref: 'Teacher', required: true },
    unavailableSlots:   [UnavailableSlotSchema],
    maxConsecutiveHours: { type: Number, default: 4, min: 1, max: 12 },
    preferredDays:      [{ type: String, enum: Object.values(WEEKDAY) }],
  },
  { _id: true }
);

// Atomic scheduling unit: one class + subject + teacher combination for the semester
const CourseRequirementSchema = new Schema(
  {
    classId:         { type: ObjectId, ref: 'Class',   required: true },
    subjectId:       { type: ObjectId, ref: 'Subject', required: true },
    teacherId:       { type: ObjectId, ref: 'Teacher', required: true },
    sessionType:     { type: String, enum: Object.values(SESSION_TYPE) },
    hoursPerWeek:    { type: Number, required: true, min: 1 },
    sessionDuration: { type: Number, default: 90, min: 30 },  // minutes
    studentCount:    { type: Number, required: true, min: 1 },
    requiresLab:     { type: Boolean, default: false },
    roomType:        { type: String, enum: Object.values(ROOM_TYPE), default: ROOM_TYPE.CLASSROOM },
    preferMorning:   { type: Boolean, default: false },
  },
  { _id: true }
);

// Physical room available on this campus for GAET allocation
const RoomRegistrySchema = new Schema(
  {
    name:     { type: String, required: true },
    capacity: { type: Number, required: true, min: 1 },
    type:     { type: String, enum: Object.values(ROOM_TYPE), default: ROOM_TYPE.CLASSROOM },
    // Optional: mark room unavailable for specific slots (maintenance, exams, etc.)
    unavailableSlots: [UnavailableSlotSchema],
  },
  { _id: true }
);

// ─────────────────────────────────────────────
// SUB-SCHEMAS — OUTPUT (generated result)
// ─────────────────────────────────────────────

// One assigned session in the generated timetable
const GeneratedSessionSchema = new Schema(
  {
    courseRequirementRef: { type: ObjectId, required: true }, // → courseRequirements._id
    slot: {
      day:       { type: String, enum: Object.values(WEEKDAY), required: true },
      startHour: { type: Number, required: true },
      endHour:   { type: Number, required: true },
    },
    roomName: { type: String, required: true },
  },
  { _id: true }
);

// Quality metrics written by the engine after generation
const QualityReportSchema = new Schema(
  {
    score:                    { type: Number },   // 0–1000
    hardConstraintsSatisfied: { type: Number },   // % 0–100
    softConstraintsSatisfied: { type: Number },   // % 0–100
    roomUtilizationPct:       { type: Number },   // % 0–100
    unplacedCourses: [{
      courseRequirementRef: { type: ObjectId },
      reason:               { type: String },
    }],
    generationDurationMs: { type: Number },
  },
  { _id: false }
);

// ─────────────────────────────────────────────
// MAIN SCHEMA
// ─────────────────────────────────────────────

const GaetConstraintSchema = new Schema(
  {
    // ── CAMPUS ISOLATION ────────────────────
    schoolCampus: {
      type:     ObjectId,
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
    semester: {
      type:     String,
      enum:     Object.values(SEMESTER),
      required: true,
    },

    // ── INPUT — CONSTRAINTS ─────────────────
    timeSlots:          [TimeSlotSchema],
    teacherPreferences: [TeacherPreferenceSchema],
    courseRequirements: [CourseRequirementSchema],
    roomRegistry:       [RoomRegistrySchema],

    // ── OUTPUT — GENERATED RESULT ───────────
    generatedSessions: [GeneratedSessionSchema],
    qualityReport:     { type: QualityReportSchema },

    // ── LIFECYCLE ───────────────────────────
    status: {
      type:    String,
      enum:    Object.values(GAET_STATUS),
      default: GAET_STATUS.DRAFT,
      index:   true,
    },

    // Timestamp recorded before handing off to worker — used for zombie job detection
    generatingStartedAt: { type: Date, default: null },
    generatedAt:         { type: Date },
    generatedBy:         { type: ObjectId, ref: 'Staff' },
    publishedAt:         { type: Date },
    publishedBy:         { type: ObjectId, ref: 'Staff' },

    // Incremented on each successful generation (allows "which run produced this?" auditing)
    generationVersion: { type: Number, default: 0 },
  },
  {
    timestamps:  true,
    collection:  'gaet_constraints',
    toJSON:      { virtuals: true },
    toObject:    { virtuals: true },
  }
);

// ─────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────

// One constraint doc per campus + year + semester — enforces the single-source-of-truth
GaetConstraintSchema.index(
  { schoolCampus: 1, academicYear: 1, semester: 1 },
  { unique: true, name: 'idx_gaet_campus_year_semester' }
);

// Fast zombie job recovery on server start
GaetConstraintSchema.index(
  { status: 1, generatingStartedAt: 1 },
  { name: 'idx_gaet_zombie_detection' }
);

// ─────────────────────────────────────────────
// VIRTUALS
// ─────────────────────────────────────────────

GaetConstraintSchema.virtual('isGenerating').get(function () {
  return this.status === GAET_STATUS.GENERATING;
});

GaetConstraintSchema.virtual('isPublishable').get(function () {
  return (
    this.status === GAET_STATUS.GENERATED ||
    this.status === GAET_STATUS.PARTIALLY_GENERATED
  );
});

// ─────────────────────────────────────────────
// JSON SERIALISATION
// ─────────────────────────────────────────────

GaetConstraintSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('GaetConstraint', GaetConstraintSchema);
module.exports.GAET_STATUS = GAET_STATUS;
module.exports.ROOM_TYPE   = ROOM_TYPE;
