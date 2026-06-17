'use strict';

const mongoose = require('mongoose');

/**
 * FeePayment — un acompte (ligne de paiement) imputé sur une StudentFee.
 * Une dette peut recevoir plusieurs paiements échelonnés ; leur somme alimente
 * `StudentFee.amountPaid`. Les champs student/schoolCampus sont dénormalisés
 * depuis la dette pour permettre des relevés et un scoping campus directs.
 */
const feePaymentSchema = new mongoose.Schema(
  {
    fee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'StudentFee',
      required: [true, 'fee is required'],
      index: true,
    },

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

    amount: {
      type: Number,
      required: [true, 'amount is required'],
      min: [0.01, 'amount must be greater than 0'],
    },

    currency: {
      type: String,
      enum: ['XAF', 'USD', 'EUR'],
      default: 'XAF',
    },

    method: {
      type: String,
      enum: ['Cash', 'Mobile Money', 'Bank Transfer', 'Cheque'],
      required: [true, 'method is required'],
    },

    // Numéro de reçu — unique s'il est fourni.
    reference: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },

    paidAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'recordedBy is required'],
    },

    notes: {
      type: String,
      maxlength: [500, 'notes must not exceed 500 characters'],
    },
  },
  {
    timestamps: true,
  }
);

// Relevé d'un étudiant trié par date.
feePaymentSchema.index({ student: 1, paidAt: -1 });

module.exports = mongoose.model('FeePayment', feePaymentSchema);
