'use strict';

const mongoose = require("mongoose");

/**
 * Expense — a recorded institutional outflow (salaries, rent, supplies…),
 * categorized via ExpenseCategory and scoped to a campus. Follows an approval
 * workflow (pending → approved → paid, or rejected). Soft-deleted via `isDeleted`.
 */
const expenseSchema = new mongoose.Schema(
  {
     // Relations
     schoolCampus: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campus",
      index: true,
    },
    
    expenseCategory:{
      type: mongoose.Schema.Types.ObjectId,
      ref: "ExpenseCategory",
      required: true,
      index: true,
    },

     paidBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", // accountant / admin who recorded the expense
      required: true,
    },

    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", // director / manager who approved it
    },

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
      type: String, // ex: FACT-2025-001
      unique: true,
      sparse: true,
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
    expenseDate: {
      type: Date,
      required: true,
      index: true,
    },

    paidAt: {
      type: Date,
    },

    // Status & control
    status: {
      type: String,
      enum: ["pending", "approved", "paid", "rejected"],
      default: "pending",
      index: true,
    },

    isRecurring: {
      type: Boolean,
      default: false,
    },

    recurringPeriod: {
      type: String,
      enum: ["monthly", "quarterly", "yearly"],
    },

    // Supporting documents
    attachments: [
      {
        type: String, // invoice / receipt URL
      },
    ],

    // Audit & security
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

expenseSchema.pre("save", function (next) {
  if (this.expenseDate) {
    this.month = this.expenseDate.getMonth() + 1;
    this.year = this.expenseDate.getFullYear();
  }
  next();
});

// Reporting: expenses of a campus over a given period.
expenseSchema.index({ schoolCampus: 1, year: 1, month: 1 });


module.exports = mongoose.model("Expense", expenseSchema);
