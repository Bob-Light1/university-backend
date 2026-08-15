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
      ref:      'Campus',
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

    /**
     * When the anti-cheat job last scanned this session. `null` means "still to scan", and
     * that is the whole candidate query.
     *
     * It replaces the previous proxy — "completed in the last 48 h" — which, evaluated by a
     * job running every 24 h, selected each session on two consecutive nights and, with an
     * append-only `$push`, recorded every finding twice. A window answers "is this session
     * recent"; the job needed "has this session been scanned", and those diverge the moment
     * the two periods differ.
     *
     * `lastSubmissionAt` is its companion: `submitExam` gates on the SUBMISSION's status,
     * not the session's, so an attempt left IN_PROGRESS can be submitted after the session
     * is COMPLETED and already scanned. A submission landing after the stamp invalidates it.
     */
    antiCheatScannedAt: { type: Date, default: null },
    lastSubmissionAt:   { type: Date, default: null },

    // Audit: reason required when cancelling/postponing/rescheduling
    cancellationReason: { type: String },
    postponeReason:     { type: String },
    rescheduleReason:   { type: String },

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
// Anti-cheat candidate scan: COMPLETED sessions not yet scanned, oldest first. Deliberately
// NOT campus-scoped — the job is platform-wide and has no `req` to derive a campus from.
examSessionSchema.index(
  { status: 1, antiCheatScannedAt: 1, completedAt: 1 },
  { partialFilterExpression: { isDeleted: false } },
);
examSessionSchema.index({ schoolCampus: 1, startTime: 1, endTime: 1 });
examSessionSchema.index(
  { classes: 1, startTime: 1 },
  { partialFilterExpression: { isDeleted: false } }
);
examSessionSchema.index({ teacher: 1, startTime: 1 });

// ── Model ─────────────────────────────────────────────────────────────────────

const ExamSession = mongoose.model('ExamSession', examSessionSchema);
module.exports = ExamSession;
