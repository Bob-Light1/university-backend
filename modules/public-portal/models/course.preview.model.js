'use strict';

/**
 * @file course.preview.model.js
 * @description Course previews (spec §4.7) — free instructional excerpts.
 *
 * NOTE: this model is a Phase 2 addition not detailed in chapters §7-8 of the spec.
 * To be formally validated by the project lead (final note of the document).
 *
 * Campus isolation: schoolCampus required. Bilingual content ({fr, en}).
 * Each excerpt is attached to a program and ends, on the portal side, on a
 * pre-registration CTA with programInterest pre-filled.
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

    // Program the excerpt is attached to (feeds programInterest)
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

    // Text excerpt of the introductory lesson
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

    // Optional short video (embed URL)
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
