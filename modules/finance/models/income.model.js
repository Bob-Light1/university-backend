const mongoose = require("mongoose");

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
        "Frais d'inscription",
        "Frais de scolarité",
        "Paiement cours",
        "Examen",
        "Certification",
        "Subvention",
        "Don",
        "Partenariat",
        "Autre",
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

    campus: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campus",
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
    }
    
  },
  {
    timestamps: true,
  }
);


incomeSchema.pre("save", function (next) {
  this.month = this.incomeDate.getMonth() + 1;
  this.year = this.incomeDate.getFullYear();
  next();
});

module.exports = mongoose.model("Income", incomeSchema);
