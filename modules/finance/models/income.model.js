'use strict';

const mongoose = require("mongoose");

/**
 * Income — a recorded inbound payment to the institution (tuition, enrollment,
 * grants, donations…). Optionally tied to a student/class/course and a campus.
 * Soft-deleted via `isDeleted`. `month`/`year` are denormalized for reporting.
 */
const incomeSchema = new mongoose.Schema(
  {
    // Identification
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150,
    },

    description: {
      type: String,
      maxlength: 500,
    },

    reference: {
      type: String, // ex: REC-2025-001
      unique: true,
      sparse: true,
    },

    // Income source
    source: {
      type: String,
      enum: [
        "Enrollment Fees",
        "Tuition",
        "Course Payment",
        "Exam",
        "Certification",
        "Grant",
        "Donation",
        "Partnership",
        "Other",
      ],
      required: true,
      index: true,
    },

    // Amounts
    amount: {
      type: Number,
      required: true,
      min: 0,
    },

    currency: {
      type: String,
      enum: ["XAF", "USD", "EUR"],
      default: "XAF",
    },

    paymentMethod: {
      type: String,
      enum: ["Cash", "Mobile Money", "Bank Transfer", "Cheque"],
      required: true,
    },

    // Dates
    incomeDate: {
      type: Date,
      required: true,
      index: true,
    },

    receivedAt: {
      type: Date,
    },

    // Relations (optional depending on the type)
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      index: true,
    },

    class: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Class",
    },

    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Course",
    },

    schoolCampus: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campus",
      index: true,
    },

    // Responsible person
    receivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", // accountant / admin
      required: true,
    },

    // Status & control
    status: {
      type: String,
      enum: ["pending", "received", "cancelled"],
      default: "received",
      index: true,
    },

    // Supporting documents
    attachments: [
      {
        type: String, // receipt / invoice URL
      },
    ],

    // Internal notes
    notes: {
      type: String,
      maxlength: 500,
    },
    
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },

    // Denormalized period for fast monthly/yearly reporting aggregations.
    month: { type: Number, min: 1, max: 12 },
    year: { type: Number },
  },
  {
    timestamps: true,
  }
);


incomeSchema.pre("save", function (next) {
  if (this.incomeDate) {
    this.month = this.incomeDate.getMonth() + 1;
    this.year = this.incomeDate.getFullYear();
  }
  next();
});

// Reporting: incomes of a campus over a given period.
incomeSchema.index({ schoolCampus: 1, year: 1, month: 1 });

module.exports = mongoose.model("Income", incomeSchema);
