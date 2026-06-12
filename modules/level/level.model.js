const mongoose = require("mongoose");

const levelSchema = new mongoose.Schema(
  {
    // Human readable name (A1, A2, B1, L1, M2, etc.)
    name: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      index: true,
    },

    // Unique technical code (useful for APIs & consistency)
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },

    // Type of level
    // language = CEFR (A1, B2...)
    // academic = L1, L2, M1...
    // professional = internal / custom
    type: {
      type: String,
      enum: ["LANGUAGE", "ACADEMIC", "PROFESSIONAL"],
      default: "LANGUAGE",
    },

    // Order for sorting (A1=1, A2=2, B1=3...)
    order: {
      type: Number,
      required: true,
      min: 1,
    },

    // Optional description
    description: {
      type: String,
      maxlength: 255,
    },

    // Soft delete / activation
    status: {
      type: String,
      enum: ["active", "archived"],
      default: "active",
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Avoid duplicates by type + code
levelSchema.index({ code: 1, type: 1}, { unique: true });

module.exports = mongoose.model("Level", levelSchema);
