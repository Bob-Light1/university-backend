'use strict';

/**
 * @file quiz.session.model.js
 * @description Participation à un quiz — session anonyme ou liée à un lead.
 *
 * Avant pré-inscription : sessionToken identifie le participant de façon anonyme.
 * Après pré-inscription  : lead (ObjectId) est renseigné, sessionToken conservé.
 * period 'YYYY-MM'        : permet de filtrer le classement mensuel.
 */

const mongoose = require('mongoose');

const quizSessionSchema = new mongoose.Schema(
  {
    schoolCampus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Campus',
      required: [true, 'Campus is required'],
      index:    true,
    },

    // Code partenaire capturé depuis le cookie au moment du quiz
    partnerCode: {
      type:    String,
      trim:    true,
      uppercase: true,
      default: null,
    },

    // Token anonyme généré côté portail — conservé même après liaison au lead.
    // L'index unique est déclaré plus bas via schema.index() — pas de index:true ici
    // (sinon Mongoose crée un index dupliqué).
    sessionToken: {
      type:     String,
      required: [true, 'Session token is required'],
    },

    // Renseigné après pré-inscription — lie la session au prospect
    lead: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'PartnerLead',
      default: null,
    },

    // Pseudonyme pour le classement, ex. 'Awa M. — Douala'
    displayName: {
      type:    String,
      trim:    true,
      default: null,
    },

    city: {
      type:    String,
      trim:    true,
      default: null,
    },

    country: {
      type:    String,
      trim:    true,
      default: null,
    },

    category: {
      type:     String,
      required: [true, 'Category is required'],
      trim:     true,
      lowercase: true,
    },

    score: {
      type:    Number,
      min:     0,
      max:     100,
      default: 0,
    },

    correctAnswers: {
      type:    Number,
      min:     0,
      default: 0,
    },

    totalQuestions: {
      type:    Number,
      min:     0,
      default: 0,
    },

    completedAt: {
      type:    Date,
      default: null,
    },

    // SHA-256 uniquement — jamais l'IP brute
    ipAddressHash: {
      type:    String,
      default: null,
    },

    // Format 'YYYY-MM' — index pour requêtes classement mensuel
    period: {
      type:    String,
      match:   [/^\d{4}-\d{2}$/, 'period must be in YYYY-MM format'],
      default: null,
      index:   true,
    },
  },
  {
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

quizSessionSchema.index({ schoolCampus: 1, period: 1, score: -1 });
quizSessionSchema.index({ schoolCampus: 1, period: 1, category: 1, score: -1 });
quizSessionSchema.index({ sessionToken: 1 }, { unique: true });

const QuizSession = mongoose.model('QuizSession', quizSessionSchema);
module.exports = QuizSession;
