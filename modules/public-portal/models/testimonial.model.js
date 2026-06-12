'use strict';

/**
 * @file testimonial.model.js
 * @description Témoignages d'anciens apprenants — preuve sociale du portail public.
 *
 * Campus isolation : schoolCampus obligatoire sur chaque document.
 * Citation bilingue (quote.fr / quote.en) — le portail choisit la langue d'affichage.
 * Seuls les documents isPublished:true sont exposés via l'endpoint public.
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

    // Formation suivie par l'ancien apprenant
    program: {
      type: String,
      trim: true,
      default: null,
    },

    // Citation bilingue — au moins fr requis
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

    // URL photo — consentement requis avant publication
    photoUrl: {
      type: String,
      trim: true,
      default: null,
    },

    // Employeur actuel — optionnel (renforce le message d'employabilité)
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

    // Ordre d'affichage croissant
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
