'use strict';

/**
 * @file quiz.question.model.js
 * @description Questions for the public pre-registration quiz.
 *
 * Security invariant: correctIndex is select:false — never exposed to the portal.
 * Campus isolation: schoolCampus required on every document.
 */

const mongoose = require('mongoose');

const quizQuestionSchema = new mongoose.Schema(
  {
    schoolCampus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Campus',
      required: [true, 'Campus is required'],
      index:    true,
    },

    category: {
      type:     String,
      required: [true, 'Category is required'],
      trim:     true,
      lowercase: true,
      // Examples: 'web', 'accounting', 'marketing', 'general'
    },

    text: {
      type:     String,
      required: [true, 'Question text is required'],
      trim:     true,
      maxlength: [500, 'Question text must not exceed 500 characters'],
    },

    // 4 options (A, B, C, D) — fixed order
    options: {
      type:     [String],
      required: true,
      validate: {
        validator: (v) => Array.isArray(v) && v.length === 4,
        message:   'A question must have exactly 4 options.',
      },
    },

    // Index (0–3) of the correct answer — NEVER exposed to the portal
    correctIndex: {
      type:     Number,
      required: [true, 'correctIndex is required'],
      min:      0,
      max:      3,
      select:   false,
    },

    difficulty: {
      type:    String,
      enum:    {
        values:  ['easy', 'medium', 'hard'],
        message: '{VALUE} is not a valid difficulty',
      },
      default: 'medium',
    },

    isPublished: {
      type:    Boolean,
      default: false,
      index:   true,
    },

    lang: {
      type:    String,
      enum:    ['fr', 'en'],
      default: 'fr',
    },
  },
  {
    timestamps: true,
    toJSON:     { virtuals: false },
    toObject:   { virtuals: false },
  }
);

quizQuestionSchema.index({ schoolCampus: 1, category: 1, isPublished: 1 });
quizQuestionSchema.index({ schoolCampus: 1, category: 1, difficulty: 1, lang: 1 });

const QuizQuestion = mongoose.model('QuizQuestion', quizQuestionSchema);
module.exports = QuizQuestion;
