'use strict';

/**
 * @file competition.prize.model.js
 * @description Monthly competition prizes (spec §8.5).
 *
 * Campus isolation: schoolCampus required. One period ('YYYY-MM') per campus.
 * prizes[]  : reward scale, defined when the competition opens.
 * winners[] : populated by the closing cron (competition.closing.cron.js) on the 1st of the month,
 *             from the top QuizSessions of the period. notifiedAt wired in Phase 3.
 */

const mongoose = require('mongoose');

// Reward scale entry — bilingual description
const prizeSchema = new mongoose.Schema(
  {
    rank: {
      type:     Number,
      required: [true, 'rank is required'],
      min:      1,
    },
    description: {
      fr: {
        type:     String,
        required: [true, 'French prize description is required'],
        trim:     true,
      },
      en: {
        type: String,
        trim: true,
        default: null,
      },
    },
    // Indicative value (e.g. '20% discount', 'Digital badge')
    value: {
      type: String,
      trim: true,
      default: null,
    },
  },
  { _id: false }
);

// Winner snapshot frozen by the closing cron
const winnerSchema = new mongoose.Schema(
  {
    rank: {
      type:     Number,
      required: true,
      min:      1,
    },
    quizSession: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'QuizSession',
      default: null,
    },
    lead: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'PartnerLead',
      default: null,
    },
    // Frozen snapshot of display name/score at closing time
    displayName: {
      type: String,
      trim: true,
      default: null,
    },
    score: {
      type:    Number,
      min:     0,
      max:     100,
      default: 0,
    },
    // Set when the notification is sent (Phase 3 — null for now)
    notifiedAt: {
      type:    Date,
      default: null,
    },
  },
  { _id: false }
);

const competitionPrizeSchema = new mongoose.Schema(
  {
    schoolCampus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Campus',
      required: [true, 'Campus is required'],
      index:    true,
    },

    // Format 'YYYY-MM' — one competition per campus per month
    period: {
      type:     String,
      required: [true, 'period is required'],
      match:    [/^\d{4}-\d{2}$/, 'period must be in YYYY-MM format'],
    },

    prizes: {
      type:    [prizeSchema],
      default: [],
    },

    // Ongoing competition; set to false by the closing cron
    isActive: {
      type:    Boolean,
      default: true,
      index:   true,
    },

    // Closing date — used for the countdown on the portal side
    closingDate: {
      type:     Date,
      required: [true, 'closingDate is required'],
    },

    // Populated by the monthly closing cron
    winners: {
      type:    [winnerSchema],
      default: [],
    },
  },
  {
    timestamps: true,
    toJSON:     { virtuals: false },
    toObject:   { virtuals: false },
  }
);

// One competition per campus per period
competitionPrizeSchema.index({ schoolCampus: 1, period: 1 }, { unique: true });

const CompetitionPrize = mongoose.model('CompetitionPrize', competitionPrizeSchema);
module.exports = CompetitionPrize;
