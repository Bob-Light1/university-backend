'use strict';

const mongoose = require('mongoose');

const examAppealSchema = new mongoose.Schema(
  {
    schoolCampus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'SchoolCampus',
      required: true,
      index:    true,
    },
    grading: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'ExamGrading',
      required: true,
    },
    student: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Student',
      required: true,
    },
    reason: {
      type:     String,
      required: true,
      minlength: [20, 'Reason must be at least 20 characters.'],
    },
    attachments: [{ type: String }],

    status: {
      type:    String,
      enum:    ['PENDING', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED'],
      default: 'PENDING',
    },

    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    resolution: { type: String },
    newScore:   { type: Number },

    deadlineAt:  { type: Date, required: true },
    resolvedAt:  { type: Date },

    isDeleted: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// ── Auto-set resolvedAt ───────────────────────────────────────────────────────

examAppealSchema.pre('save', function (next) {
  if (
    this.isModified('status') &&
    ['RESOLVED', 'REJECTED'].includes(this.status) &&
    !this.resolvedAt
  ) {
    this.resolvedAt = new Date();
  }
  next();
});

// ── Indexes ───────────────────────────────────────────────────────────────────

examAppealSchema.index(
  { grading: 1, student: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);
examAppealSchema.index({ status: 1, deadlineAt: 1 });

const ExamAppeal = mongoose.model('ExamAppeal', examAppealSchema);
module.exports = ExamAppeal;
