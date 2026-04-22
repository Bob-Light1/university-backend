'use strict';

const mongoose = require('mongoose');
const examConfig = require('../../configs/exam.config');

const RubricScoreSchema = new mongoose.Schema(
  {
    criterion: { type: String, required: true },
    points:    { type: Number, required: true },
    maxPoints: { type: Number, required: true },
    comment:   { type: String },
  },
  { _id: false }
);

const AnnotationSchema = new mongoose.Schema(
  {
    page: { type: Number },
    x:    { type: Number },
    y:    { type: Number },
    text: { type: String },
    type: { type: String },
  },
  { _id: false }
);

const examGradingSchema = new mongoose.Schema(
  {
    schoolCampus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'SchoolCampus',
      required: true,
      index:    true,
    },
    submission: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'ExamSubmission',
      required: true,
    },
    examSession: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'ExamSession',
      required: true,
    },
    student: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Student',
      required: true,
    },
    grader: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Teacher',
      required: true,
    },
    secondGrader: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'Teacher',
    },

    score:           { type: Number, required: true, min: 0 },
    maxScore:        { type: Number, required: true, min: 1 },
    normalizedScore: { type: Number },

    rubricScores: [RubricScoreSchema],
    annotations:  [AnnotationSchema],

    graderFeedback: { type: String },
    isBlindGrading: { type: Boolean, default: false },

    secondScore:      { type: Number },
    scoreDiscrepancy: { type: Number },
    needsMediation:   { type: Boolean, default: false },
    mediatorScore:    { type: Number },
    finalScore:       { type: Number },

    status: {
      type:    String,
      enum:    ['PENDING', 'GRADED', 'DOUBLE_GRADED', 'MEDIATED', 'PUBLISHED'],
      default: 'PENDING',
    },

    publishedAt:       { type: Date },
    certificateToken:  { type: String, index: true, sparse: true },

    isDeleted: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// ── Pre-save: compute derived fields ─────────────────────────────────────────

examGradingSchema.pre('save', function (next) {
  // normalizedScore = score × 20 / maxScore
  if (this.score != null && this.maxScore) {
    this.normalizedScore = Math.round((this.score * 20 / this.maxScore) * 100) / 100;
  }

  // scoreDiscrepancy + needsMediation
  if (this.secondScore != null && this.maxScore) {
    const secondNorm = Math.round((this.secondScore * 20 / this.maxScore) * 100) / 100;
    this.scoreDiscrepancy = Math.abs((this.normalizedScore || 0) - secondNorm);
    this.needsMediation   = this.scoreDiscrepancy > examConfig.gradingDiscrepancyThreshold;
  }

  // finalScore resolution: mediatorScore > avg(score, secondScore) > score
  if (this.mediatorScore != null) {
    this.finalScore = this.mediatorScore;
  } else if (this.secondScore != null && this.score != null) {
    this.finalScore = Math.round(((this.score + this.secondScore) / 2) * 100) / 100;
  } else {
    this.finalScore = this.score;
  }

  // publishedAt timestamp
  if (this.isModified('status') && this.status === 'PUBLISHED' && !this.publishedAt) {
    this.publishedAt = new Date();
  }

  next();
});

// ── Indexes ───────────────────────────────────────────────────────────────────

examGradingSchema.index(
  { submission: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);
examGradingSchema.index({ examSession: 1, status: 1 });
examGradingSchema.index({ grader: 1, status: 1 });

const ExamGrading = mongoose.model('ExamGrading', examGradingSchema);
module.exports = ExamGrading;
