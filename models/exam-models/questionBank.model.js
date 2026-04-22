'use strict';

const mongoose = require('mongoose');

// ── Sub-schemas ───────────────────────────────────────────────────────────────

const OptionSchema = new mongoose.Schema(
  {
    text:        { type: String, required: true },
    isCorrect:   { type: Boolean, default: false },
    explanation: { type: String },
  },
  { _id: false }
);

const TranslationSchema = new mongoose.Schema(
  {
    lang:         { type: String, required: true },
    questionText: { type: String, required: true },
    options:      [{ text: String, isCorrect: Boolean, explanation: String }],
    instructions: { type: String },
  },
  { _id: false }
);

// ── Main schema ───────────────────────────────────────────────────────────────

const questionBankSchema = new mongoose.Schema(
  {
    schoolCampus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'SchoolCampus',
      required: true,
      index:    true,
    },
    subject: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Subject',
      required: true,
    },
    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'Course',
    },
    questionText: {
      type:     String,
      required: true,
      trim:     true,
    },
    questionType: {
      type:     String,
      required: true,
      enum:     ['MCQ', 'OPEN', 'TRUE_FALSE', 'MATCHING', 'FILE_UPLOAD'],
    },
    difficulty: {
      type:     String,
      required: true,
      enum:     ['EASY', 'MEDIUM', 'HARD', 'EXPERT'],
    },
    bloomLevel: {
      type: String,
      enum: ['REMEMBER', 'UNDERSTAND', 'APPLY', 'ANALYZE', 'EVALUATE', 'CREATE'],
    },
    options:       [OptionSchema],
    correctAnswer: { type: String },
    points:        { type: Number, default: 1, min: 0 },
    tags:          [{ type: String, trim: true }],
    language:      { type: String, default: 'en' },
    translations:  [TranslationSchema],
    autoTranslate: { type: Boolean, default: false },

    // Psychometric — updated asynchronously after grading batches
    usageCount:        { type: Number, default: 0 },
    lastUsedAt:        { type: Date },
    discriminationIdx: { type: Number },
    difficultyIndex:   { type: Number },

    isActive:  { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// ── Indexes ───────────────────────────────────────────────────────────────────

questionBankSchema.index(
  { schoolCampus: 1, subject: 1, difficulty: 1, isActive: 1 },
  { partialFilterExpression: { isDeleted: false } }
);
questionBankSchema.index({ schoolCampus: 1, tags: 1 });
questionBankSchema.index({ subject: 1, usageCount: 1 });

// ── Model ─────────────────────────────────────────────────────────────────────

const QuestionBank = mongoose.model('QuestionBank', questionBankSchema);
module.exports = QuestionBank;
