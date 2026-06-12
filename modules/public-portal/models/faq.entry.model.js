'use strict';

/**
 * @file faq.entry.model.js
 * @description Questions fréquentes du portail public — contenu bilingue.
 *
 * Campus isolation : schoolCampus obligatoire sur chaque document.
 * question/answer sont bilingues ({fr, en}) — le portail choisit la langue.
 * Mise en cache 24h côté portail (spec §4.11) — peu de mutations attendues.
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

    // Regroupement thématique — ex. 'inscription', 'tarifs', 'formations'
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
