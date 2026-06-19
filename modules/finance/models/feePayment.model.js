'use strict';

const mongoose = require('mongoose');

/**
 * FeePayment — an installment (payment line) applied to a StudentFee.
 * A debt can receive several staggered payments; their sum feeds
 * `StudentFee.amountPaid`. The student/schoolCampus fields are denormalized
 * from the debt to allow direct ledgers and campus scoping.
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

    // Receipt number — unique if provided.
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

// A student's ledger sorted by date.
feePaymentSchema.index({ student: 1, paidAt: -1 });

module.exports = mongoose.model('FeePayment', feePaymentSchema);
