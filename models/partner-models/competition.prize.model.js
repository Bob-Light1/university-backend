'use strict';

/**
 * @file competition.prize.model.js
 * @description Prix de la compétition mensuelle (spec §8.5).
 *
 * Campus isolation : schoolCampus obligatoire. Une période ('YYYY-MM') par campus.
 * prizes[]   : barème des récompenses, défini à l'ouverture de la compétition.
 * winners[]  : peuplé par le cron de clôture (competition.closing.cron.js) le 1er du mois,
 *              depuis les meilleures QuizSession de la période. notifiedAt branché en Phase 3.
 */

const mongoose = require('mongoose');

// Barème d'une récompense — description bilingue
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
    // Valeur indicative (ex. '20% de réduction', 'Badge numérique')
    value: {
      type: String,
      trim: true,
      default: null,
    },
  },
  { _id: false }
);

// Gagnant figé par le cron de clôture
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
    // Copie figée du pseudonyme/score au moment de la clôture
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
    // Renseigné quand la notification est envoyée (Phase 3 — null pour l'instant)
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

    // Format 'YYYY-MM' — une compétition par campus et par mois
    period: {
      type:     String,
      required: [true, 'period is required'],
      match:    [/^\d{4}-\d{2}$/, 'period must be in YYYY-MM format'],
    },

    prizes: {
      type:    [prizeSchema],
      default: [],
    },

    // Compétition en cours ; passée à false par le cron de clôture
    isActive: {
      type:    Boolean,
      default: true,
      index:   true,
    },

    // Date de clôture — utilisée pour le countdown côté portail
    closingDate: {
      type:     Date,
      required: [true, 'closingDate is required'],
    },

    // Peuplé par le cron de clôture mensuelle
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

// Une seule compétition par campus et par période
competitionPrizeSchema.index({ schoolCampus: 1, period: 1 }, { unique: true });

const CompetitionPrize = mongoose.model('CompetitionPrize', competitionPrizeSchema);
module.exports = CompetitionPrize;
