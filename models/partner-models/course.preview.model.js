'use strict';

/**
 * @file course.preview.model.js
 * @description Aperçus de cours (spec §4.7) — extraits pédagogiques gratuits.
 *
 * NOTE : ce modèle est un ajout Phase 2 non détaillé dans les chapitres §7-8 de la spec.
 * À faire valider formellement par le responsable projet (note finale du document).
 *
 * Campus isolation : schoolCampus obligatoire. Contenu bilingue ({fr, en}).
 * Chaque extrait est rattaché à un program et se termine, côté portail, sur un CTA
 * de pré-inscription avec programInterest pré-rempli.
 */

const mongoose = require('mongoose');

const coursePreviewSchema = new mongoose.Schema(
  {
    schoolCampus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Campus',
      required: [true, 'Campus is required'],
      index:    true,
    },

    // Formation à laquelle l'extrait est rattaché (alimente programInterest)
    program: {
      type:     String,
      required: [true, 'program is required'],
      trim:     true,
    },

    title: {
      fr: {
        type:     String,
        required: [true, 'French title is required'],
        trim:     true,
        maxlength: [200, 'Title must not exceed 200 characters'],
      },
      en: {
        type: String,
        trim: true,
        default: null,
        maxlength: [200, 'Title must not exceed 200 characters'],
      },
    },

    // Extrait texte de la leçon introductive
    content: {
      fr: {
        type:     String,
        required: [true, 'French content is required'],
        trim:     true,
        maxlength: [4000, 'Content must not exceed 4000 characters'],
      },
      en: {
        type: String,
        trim: true,
        default: null,
        maxlength: [4000, 'Content must not exceed 4000 characters'],
      },
    },

    // Vidéo courte optionnelle (URL d'intégration)
    videoUrl: {
      type: String,
      trim: true,
      default: null,
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

coursePreviewSchema.index({ schoolCampus: 1, isPublished: 1, order: 1 });
coursePreviewSchema.index({ schoolCampus: 1, program: 1, isPublished: 1 });

const CoursePreview = mongoose.model('CoursePreview', coursePreviewSchema);
module.exports = CoursePreview;
