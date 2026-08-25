'use strict';

const mongoose = require('mongoose');
const { computeStatus, STATUSES } = require('../fee-status');
const { REMINDER_KIND_VALUES } = require('../fee-reminder-kind');

/**
 * One pre-due notice actually sent for a debt. `_id: false` — these rows are
 * identified by their `kind`, never referenced from anywhere, and the array is
 * read on every sweep.
 */
const reminderSentSchema = new mongoose.Schema(
  {
    kind:   { type: String, enum: REMINDER_KIND_VALUES, required: true },
    sentAt: { type: Date, required: true },
  },
  { _id: false }
);

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

    // Pre-due cadence (J-7 / J-3 / due day) — ONE entry per kind, ever.
    // Deliberately NOT the two fields above: those govern the REPEATING overdue
    // cadence and are claimed under `lastRemindedAt < cutoff`, so writing them
    // here would let a pre-due notice cancel the overdue one. See
    // `fee-reminder-kind.js` for the full reasoning.
    remindersSent: {
      type: [reminderSentSchema],
      default: [],
      validate: {
        // The claim that keeps the sweep multi-instance safe is
        // `remindersSent.kind $ne <kind>` + `$push`. That is only idempotent
        // while a kind appears at most once, so the invariant is enforced here
        // rather than trusted: a duplicate would send the same notice twice.
        validator: (rows) => {
          const kinds = rows.map((row) => row.kind);
          return new Set(kinds).size === kinds.length;
        },
        message: 'remindersSent must hold at most one entry per reminder kind',
      },
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
// Pre-due sweep AND the past-due transition: both match an unpaid status then
// scan a due-date window, so one index serves the two writes of the nightly run.
studentFeeSchema.index({ status: 1, dueDate: 1 });

module.exports = mongoose.model('StudentFee', studentFeeSchema);
