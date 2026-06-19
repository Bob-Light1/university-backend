'use strict';

/**
 * @file faq.entry.model.js
 * @description Frequently asked questions for the public portal — bilingual content.
 *
 * Campus isolation: schoolCampus required on every document.
 * question/answer are bilingual ({fr, en}) — the portal picks the language.
 * Cached 24h on the portal side (spec §4.11) — few mutations expected.
 */

const mongoose = require('mongoose');

const faqEntrySchema = new mongoose.Schema(
  {
    schoolCampus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Campus',
      required: [true, 'Campus is required'],
      index:    true,
    },

    question: {
      fr: {
        type:     String,
        required: [true, 'French question is required'],
        trim:     true,
        maxlength: [300, 'Question must not exceed 300 characters'],
      },
      en: {
        type: String,
        trim: true,
        default: null,
        maxlength: [300, 'Question must not exceed 300 characters'],
      },
    },

    answer: {
      fr: {
        type:     String,
        required: [true, 'French answer is required'],
        trim:     true,
        maxlength: [2000, 'Answer must not exceed 2000 characters'],
      },
      en: {
        type: String,
        trim: true,
        default: null,
        maxlength: [2000, 'Answer must not exceed 2000 characters'],
      },
    },

    // Thematic grouping — e.g. 'enrollment', 'pricing', 'programs'
    category: {
      type:    String,
      trim:    true,
      lowercase: true,
      default: 'general',
    },

    order: {
      type:    Number,
      default: 0,
    },

    isPublished: {
      type:    Boolean,
      default: false,
      index:   true,
    },
  },
  {
    timestamps: true,
    toJSON:     { virtuals: false },
    toObject:   { virtuals: false },
  }
);

faqEntrySchema.index({ schoolCampus: 1, isPublished: 1, order: 1 });

const FaqEntry = mongoose.model('FaqEntry', faqEntrySchema);
module.exports = FaqEntry;
