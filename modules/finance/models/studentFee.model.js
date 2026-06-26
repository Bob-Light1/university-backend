'use strict';

const mongoose = require('mongoose');
const { computeStatus, STATUSES } = require('../fee-status');

/**
 * StudentFee — a student's debt/payment obligation (tuition,
 * enrollment, certification…). Payment tracking (successive installments)
 * is done via the FeePayment model, which feeds `amountPaid` here.
 *
 * `status` is derived (never freely entered) — see fee-status.js. The field
 * stays persisted to allow efficient filters and indexes on the list side.
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

    // Human-readable label, e.g. « Tuition 2025-2026 », « Enrollment fees ».
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

    // Running total of attached FeePayments — maintained by the service (never entered).
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

    // Overdue-reminder cadence (dunning): set each time a balance reminder is sent
    // for this debt, so the nightly sweep re-reminds at most once per window and
    // never spams a student night after night.
    lastRemindedAt: { type: Date, default: null },
    reminderCount:  { type: Number, default: 0 },

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

// Remaining balance to settle (never negative).
studentFeeSchema.virtual('balance').get(function () {
  return Math.max(0, (this.amountDue || 0) - (this.amountPaid || 0));
});

// Derived status recalculated on every save (creation + payment).
studentFeeSchema.pre('save', function (next) {
  this.status = computeStatus(this);
  next();
});

// List/dashboard: quickly find a campus's open debts.
studentFeeSchema.index({ schoolCampus: 1, status: 1 });
// Overdue-reminder sweep: find overdue debts due for a (re)reminder.
studentFeeSchema.index({ status: 1, lastRemindedAt: 1 });

module.exports = mongoose.model('StudentFee', studentFeeSchema);
