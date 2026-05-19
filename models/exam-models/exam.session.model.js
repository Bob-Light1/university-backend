'use strict';

const mongoose = require('mongoose');

// ── Sub-schemas ───────────────────────────────────────────────────────────────

const QuestionRefSchema = new mongoose.Schema(
  {
    questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'QuestionBank', required: true },
    order:      { type: Number },
    points:     { type: Number },
    shuffle:    { type: Boolean, default: true },
  },
  { _id: false }
);

const RoomSchema = new mongoose.Schema(
  {
    code:     { type: String, required: true },
    building: { type: String },
    capacity: { type: Number },
  },
  { _id: false }
);

const VirtualMeetingSchema = new mongoose.Schema(
  {
    platform:   { type: String },
    url:        { type: String },
    accessCode: { type: String },
  },
  { _id: false }
);

const EligibilityRulesSchema = new mongoose.Schema(
  {
    minAttendance:       { type: Number, min: 0, max: 100 },
    prerequisiteCourses: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Course' }],
  },
  { _id: false }
);

const AntiCheatConfigSchema = new mongoose.Schema(
  {
    tabSwitchLimit:    { type: Number, default: 3 },
    lockdownBrowser:   { type: Boolean, default: false },
    detectPaste:       { type: Boolean, default: true },
  },
  { _id: false }
);

// ── Main schema ───────────────────────────────────────────────────────────────

const examSessionSchema = new mongoose.Schema(
  {
    schoolCampus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'SchoolCampus',
      required: true,
      index:    true,
    },
    title: {
      type:     String,
      required: true,
      trim:     true,
    },
    subject: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Subject',
      required: true,
    },
    classes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true }],
    teacher: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Teacher',
      required: true,
    },
    invigilators: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' }],

    academicYear: {
      type:     String,
      required: true,
      match:    /^\d{4}-\d{4}$/,
    },
    semester: {
      type:     String,
      required: true,
      enum:     ['S1', 'S2', 'Annual'],
    },
    examPeriod: {
      type:     String,
      required: true,
      enum:     ['MIDTERM', 'FINAL', 'RETAKE', 'CONTINUOUS', 'SPECIAL'],
    },
    mode: {
      type:     String,
      required: true,
      enum:     ['PHYSICAL', 'ONLINE', 'HYBRID'],
    },
    status: {
      type:    String,
      enum:    ['DRAFT', 'SCHEDULED', 'ONGOING', 'COMPLETED', 'CANCELLED', 'POSTPONED'],
      default: 'DRAFT',
    },

    startTime:   { type: Date, required: true },
    endTime:     { type: Date, required: true },
    duration:    { type: Number, required: true, min: 1 },

    room:           { type: RoomSchema },
    virtualMeeting: { type: VirtualMeetingSchema },

    questions:        [QuestionRefSchema],
    shuffleQuestions: { type: Boolean, default: true },
    shuffleOptions:   { type: Boolean, default: true },

    maxScore:         { type: Number, required: true, min: 1 },
    gradingScale:     { type: mongoose.Schema.Types.ObjectId, ref: 'GradingScale' },
    eligibilityRules: { type: EligibilityRulesSchema },
    instructions:     { type: String },
    allowedMaterials: [{ type: String }],
    antiCheatConfig:  { type: AntiCheatConfigSchema },

    offlineSupported: { type: Boolean, default: false },

    publishedAt:  { type: Date },
    completedAt:  { type: Date },
    scheduleRef:  { type: mongoose.Schema.Types.ObjectId, ref: 'StudentSchedule' },

    // Audit: reason required when cancelling/postponing
    cancellationReason: { type: String },
    postponeReason:     { type: String },

    isDeleted: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// ── Validation ────────────────────────────────────────────────────────────────

examSessionSchema.pre('validate', function (next) {
  if (this.endTime && this.startTime && this.endTime <= this.startTime) {
    return next(new Error('endTime must be strictly after startTime.'));
  }
  next();
});

// ── Auto-timestamps on status transitions ─────────────────────────────────────

examSessionSchema.pre('save', function (next) {
  if (this.isModified('status')) {
    if (this.status === 'SCHEDULED' && !this.publishedAt) this.publishedAt = new Date();
    if (this.status === 'COMPLETED' && !this.completedAt) this.completedAt = new Date();
  }
  next();
});

// ── Indexes ───────────────────────────────────────────────────────────────────

examSessionSchema.index({ schoolCampus: 1, academicYear: 1, semester: 1, status: 1 });
examSessionSchema.index({ schoolCampus: 1, startTime: 1, endTime: 1 });
examSessionSchema.index(
  { classes: 1, startTime: 1 },
  { partialFilterExpression: { isDeleted: false } }
);
examSessionSchema.index({ teacher: 1, startTime: 1 });

// ── Model ─────────────────────────────────────────────────────────────────────

const ExamSession = mongoose.model('ExamSession', examSessionSchema);
module.exports = ExamSession;
