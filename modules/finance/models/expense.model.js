const mongoose = require("mongoose");

const expenseSchema = new mongoose.Schema(
  {
     // Relations
     schoolCampus: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SchoolCampus",
    },
    
    expenseCategory:{
      type: mongoose.Schema.Types.ObjectId,
      ref: "ExpenseCategory",
      required: true,
      index: true,
    },

     paidBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin", // comptable / admin
      required: true,
    },

    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin", // directeur
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

    // Montants
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

    // Statut & contrôle
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

    // Justificatifs
    attachments: [
      {
        type: String, // URL facture / reçu
      },
    ],

    // Audit & sécurité
    notes: {
      type: String,
      maxlength: 500,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    }
  },
  {
    timestamps: true,
  }
);

expenseSchema.pre("save", function (next) {
  this.month = this.expenseDate.getMonth() + 1;
  this.year = this.expenseDate.getFullYear();
  next();
});


module.exports = mongoose.model("Expense", expenseSchema);
