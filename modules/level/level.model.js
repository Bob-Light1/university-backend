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

    // Technical code (useful for APIs & consistency).
    // Uniqueness is enforced per (code, type) via the compound index below,
    // matching the repository's findByCodeAndType uniqueness check.
    code: {
      type: String,
      required: true,
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
      trim: true,
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

// Enforce uniqueness of a code within a given type (e.g. "A1" can exist once
// per level type). This is the single source of truth for level uniqueness.
levelSchema.index({ code: 1, type: 1 }, { unique: true });

// Supports the common listing query: filter by status/type, sort by order.
levelSchema.index({ status: 1, type: 1, order: 1 });

module.exports = mongoose.model("Level", levelSchema);
