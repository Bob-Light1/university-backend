'use strict';

const mongoose = require('mongoose');
const { computeStatus, STATUSES } = require('../fee-status');

/**
 * StudentFee — une dette/obligation de paiement d'un étudiant (scolarité,
 * inscription, certification…). Le suivi du paiement (acomptes successifs)
 * se fait via le model FeePayment, qui alimente `amountPaid` ici.
 *
 * `status` est dérivé (jamais saisi librement) — voir fee-status.js. Le champ
 * reste persisté pour permettre filtres et index efficaces côté liste.
 */
const studentFeeSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
      required: [true, 'student is required'],
      index: true,
    },

    schoolCampus: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Campus',
      required: [true, 'schoolCampus is required'],
      index: true,
    },

    // Libellé lisible, ex: « Scolarité 2025-2026 », « Frais d'inscription ».
    label: {
      type: String,
      required: [true, 'label is required'],
      trim: true,
      maxlength: [150, 'label must not exceed 150 characters'],
    },

    academicYear: {
      type: String,
      trim: true,
      maxlength: [20, 'academicYear must not exceed 20 characters'],
      index: true,
    },

    amountDue: {
      type: Number,
      required: [true, 'amountDue is required'],
      min: [0, 'amountDue cannot be negative'],
    },

    // Cumul des FeePayment rattachés — maintenu par le service (jamais saisi).
    amountPaid: {
      type: Number,
      default: 0,
      min: [0, 'amountPaid cannot be negative'],
    },

    currency: {
      type: String,
      enum: ['XAF', 'USD', 'EUR'],
      default: 'XAF',
    },

    dueDate: {
      type: Date,
      default: null,
    },

    status: {
      type: String,
      enum: STATUSES,
      default: 'pending',
      index: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    notes: {
      type: String,
      maxlength: [500, 'notes must not exceed 500 characters'],
    },

    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Solde restant à régler (jamais négatif).
studentFeeSchema.virtual('balance').get(function () {
  return Math.max(0, (this.amountDue || 0) - (this.amountPaid || 0));
});

// Statut dérivé recalculé à chaque sauvegarde (création + acompte).
studentFeeSchema.pre('save', function (next) {
  this.status = computeStatus(this);
  next();
});

// Liste/dashboard : retrouver vite les dettes ouvertes d'un campus.
studentFeeSchema.index({ schoolCampus: 1, status: 1 });

module.exports = mongoose.model('StudentFee', studentFeeSchema);
