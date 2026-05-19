'use strict';

const mongoose = require('mongoose');

const AnswerSchema = new mongoose.Schema(
  {
    questionId:     { type: mongoose.Schema.Types.ObjectId, ref: 'QuestionBank', required: true },
    selectedOption: { type: Number },
    openText:       { type: String },
    fileUrl:        { type: String },
    savedAt:        { type: Date, default: Date.now },
  },
  { _id: false }
);

const AntiCheatFlagSchema = new mongoose.Schema(
  {
    type:      { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    detail:    { type: String },
  },
  { _id: false }
);

const examSubmissionSchema = new mongoose.Schema(
  {
    schoolCampus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'SchoolCampus',
      required: true,
      index:    true,
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

    answers: [AnswerSchema],

    startedAt:       { type: Date, required: true, default: Date.now },
    submittedAt:     { type: Date },
    autoSubmittedAt: { type: Date },

    // Audit — MUST be excluded from student-facing API responses
    ipAddress: { type: String, select: false },
    userAgent: { type: String, select: false },

    tabSwitchCount: { type: Number, default: 0 },
    antiCheatFlags: [AntiCheatFlagSchema],

    // For physical exams
    scannedCopyUrl: { type: String },

    status: {
      type:     String,
      required: true,
      enum:     ['IN_PROGRESS', 'SUBMITTED', 'GRADED', 'FLAGGED'],
      default:  'IN_PROGRESS',
    },

    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// ── Unique constraint: one attempt per student per session ────────────────────

examSubmissionSchema.index(
  { examSession: 1, student: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);
examSubmissionSchema.index({ examSession: 1, status: 1 });

const ExamSubmission = mongoose.model('ExamSubmission', examSubmissionSchema);
module.exports = ExamSubmission;
