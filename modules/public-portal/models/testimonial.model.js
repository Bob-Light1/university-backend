'use strict';

/**
 * @file testimonial.model.js
 * @description Alumni testimonials — social proof for the public portal.
 *
 * Campus isolation: schoolCampus required on every document.
 * Bilingual quote (quote.fr / quote.en) — the portal picks the display language.
 * Only isPublished:true documents are exposed via the public endpoint.
 */

const mongoose = require('mongoose');

const testimonialSchema = new mongoose.Schema(
  {
    schoolCampus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Campus',
      required: [true, 'Campus is required'],
      index:    true,
    },

    firstName: {
      type:     String,
      required: [true, 'First name is required'],
      trim:     true,
    },

    city: {
      type: String,
      trim: true,
      default: null,
    },

    graduationYear: {
      type: Number,
      min:  [1990, 'graduationYear seems too old'],
      max:  [2100, 'graduationYear seems too far in the future'],
      default: null,
    },

    // Program attended by the alumni
    program: {
      type: String,
      trim: true,
      default: null,
    },

    // Bilingual quote — at least fr required
    quote: {
      fr: {
        type:     String,
        required: [true, 'French quote is required'],
        trim:     true,
        maxlength: [600, 'Quote must not exceed 600 characters'],
      },
      en: {
        type: String,
        trim: true,
        default: null,
        maxlength: [600, 'Quote must not exceed 600 characters'],
      },
    },

    // Photo URL — consent required before publishing
    photoUrl: {
      type: String,
      trim: true,
      default: null,
    },

    // Current employer — optional (reinforces the employability message)
    employer: {
      type: String,
      trim: true,
      default: null,
    },

    isPublished: {
      type:    Boolean,
      default: false,
      index:   true,
    },

    // Ascending display order
    order: {
      type:    Number,
      default: 0,
    },
  },
  {
    timestamps: true,
    toJSON:     { virtuals: false },
    toObject:   { virtuals: false },
  }
);

testimonialSchema.index({ schoolCampus: 1, isPublished: 1, order: 1 });

const Testimonial = mongoose.model('Testimonial', testimonialSchema);
module.exports = Testimonial;
