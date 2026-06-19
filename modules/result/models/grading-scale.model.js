'use strict';

/**
 * @file gradingScale.model.js  (v2)
 * @description Configurable grading scales per campus.
 */

const mongoose = require('mongoose');

// ─── ENUMS ────────────────────────────────────────────────────────────────────

const GRADING_SYSTEM = Object.freeze({
  NUMERIC_20:  'NUMERIC_20',   // Out of 20  (French system)
  NUMERIC_100: 'NUMERIC_100',  // Out of 100 (Anglo-Saxon system)
  LETTER:      'LETTER',       // A, B, C, D, E, F
  GPA:         'GPA',          // 0.0 – 4.0
});

// ─── BAND SUB-SCHEMA ──────────────────────────────────────────────────────────

/**
 * Grade band (mention bracket).
 */
const GradeBandSchema = new mongoose.Schema(
  {
    /** Inclusive minimum score (within the scale's maxScore range) */
    min:         { type: Number, required: true },
    /** Inclusive maximum score */
    max:         { type: Number, required: true },
    /** Grade letter — required for LETTER and GPA systems */
    letterGrade: { type: String, uppercase: true, trim: true },
    /** Label displayed on the transcript (e.g. "Très Bien") */
    label:       { type: String, required: true, trim: true },
    /** GPA equivalent 0.0–4.0 for international equivalence */
    gpa:         { type: Number, min: 0, max: 4 },
    /** ECTS grade for international mobility */
    ectsGrade:   { type: String, enum: ['A', 'B', 'C', 'D', 'E', 'FX', 'F'] },
    /** ECTS credits associated with this band */
    ectsCredits: { type: Number, min: 0 },
    /** Couleur hex pour l'affichage UI du bulletin */
    color:       {
      type:  String,
      match: [/^#[0-9A-Fa-f]{6}$/, 'Color must be a 6-digit hex (e.g. #FF5733)'],
    },
  },
  { _id: false }
);

// ─── MAIN SCHEMA ──────────────────────────────────────────────────────────────

const GradingScaleSchema = new mongoose.Schema(
  {
    // ── CAMPUS ISOLATION ─────────────────────
    schoolCampus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Campus',
      required: [true, 'Campus is required'],
      index:    true,
    },

    // ── IDENTIFICATION ────────────────────────
    name: {
      type:      String,
      required:  [true, 'Name is required'],
      trim:      true,
      maxlength: [100, 'Name must not exceed 100 characters'],
    },
    description: {
      type:      String,
      trim:      true,
      maxlength: [300, 'Description must not exceed 300 characters'],
    },

    // ── GRADING SYSTEM ───────────────────────
    system: {
      type:     String,
      enum:     { values: Object.values(GRADING_SYSTEM), message: '{VALUE} is not a valid grading system' },
      required: [true, 'Grading system is required'],
    },

    /**
     * Maximum possible score in this grading scale.
     * Supports decimals (e.g. 4.0 for GPA, 20, 100).
     */
    maxScore: {
      type:     Number,
      required: [true, 'Max score is required'],
      min:      [0.01, 'Max score must be positive'],
    },

    /** Minimum score to pass the subject */
    passMark: {
      type:     Number,
      required: [true, 'Pass mark is required'],
      min:      [0, 'Pass mark cannot be negative'],
    },

    /**
     * Grade bands (mention brackets).
     * Auto-sorted by ascending min in pre-save.
     * Overlaps are detected and rejected.
     */
    bands: { type: [GradeBandSchema], default: [] },

    /** One default grading scale per campus (invariant enforced in pre-save). */
    isDefault: { type: Boolean, default: false, index: true },
    isActive:  { type: Boolean, default: true,  index: true },

    // ── AUDIT ─────────────────────────────────
    /** String = req.user.id — consistent with all audit fields in the project */
    createdBy: { type: String },
    updatedBy: { type: String },
  },
  {
    timestamps: true,
    collection: 'grading_scales',
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ─── INDEXES ──────────────────────────────────────────────────────────────────

GradingScaleSchema.index({ schoolCampus: 1, isDefault: 1 });
GradingScaleSchema.index({ schoolCampus: 1, isActive:  1 });
// Name uniqueness per campus (prevents duplicate scale names)
GradingScaleSchema.index(
  { schoolCampus: 1, name: 1 },
  { unique: true, name: 'idx_grading_scale_name_per_campus' }
);

// ─── PRE-SAVE ─────────────────────────────────────────────────────────────────

GradingScaleSchema.pre('save', async function (next) {
  try {

    // ── 1. Invariant : un seul isDefault par campus ───────────────────────────
    if (this.isModified('isDefault') && this.isDefault) {
      await this.constructor.updateMany(
        { schoolCampus: this.schoolCampus, _id: { $ne: this._id } },
        { $set: { isDefault: false } }
      );
    }

    // ── 2. [S1-3] Decimal normalisation (IEEE 754) ────────────────────────────
    if (this.maxScore != null) this.maxScore = parseFloat(this.maxScore.toFixed(4));
    if (this.passMark != null) this.passMark = parseFloat(this.passMark.toFixed(4));

    // ── 3. Validation basique passMark ≤ maxScore ─────────────────────────────
    if (this.passMark > this.maxScore) {
      return next(new Error(`passMark (${this.passMark}) cannot exceed maxScore (${this.maxScore}).`));
    }

    // ── 4. [S1-1] Validation + tri des tranches (bands) ──────────────────────
    if (this.isModified('bands') && this.bands.length > 0) {

      // 4a. Basic validation of each band
      for (let i = 0; i < this.bands.length; i++) {
        const b = this.bands[i];

        if (b.min == null || b.max == null) {
          return next(new Error(`Band at index ${i}: min and max are required.`));
        }
        // [S1-3] Normaliser les bornes aussi
        b.min = parseFloat(b.min.toFixed(4));
        b.max = parseFloat(b.max.toFixed(4));

        if (b.min >= b.max) {
          return next(new Error(
            `Band at index ${i} is invalid: min (${b.min}) must be strictly less than max (${b.max}).`
          ));
        }
        if (b.min < 0 || b.max > this.maxScore) {
          return next(new Error(
            `Band at index ${i} [${b.min}–${b.max}] is out of range [0, ${this.maxScore}].`
          ));
        }
      }

      // 4b. Sort by ascending min (auto-correction — API friendliness)
      this.bands.sort((a, b) => a.min - b.min);

      // 4c. Overlap detection after sort
      for (let i = 0; i < this.bands.length - 1; i++) {
        const cur  = this.bands[i];
        const next_ = this.bands[i + 1];
        if (cur.max >= next_.min) {
          return next(new Error(
            `Bands overlap: [${cur.min}–${cur.max}] and [${next_.min}–${next_.max}]. ` +
            `Max of band ${i} (${cur.max}) must be strictly less than min of band ${i + 1} (${next_.min}).`
          ));
        }
      }

      // 4d. Avertissement si passMark n'est couvert par aucune tranche
      const passInBand = this.bands.some((b) => this.passMark >= b.min && this.passMark <= b.max);
      if (!passInBand) {
        // Non-blocking warning — the scale remains usable
        console.warn(
          `[GradingScale "${this.name}"] passMark=${this.passMark} is not covered by any band. ` +
          `Grade resolution at passing threshold will return null.`
        );
      }
    }

    next();
  } catch (err) {
    next(err);
  }
});

// ─── INSTANCE METHODS ─────────────────────────────────────────────────────────

/**
 * Resolves the grade band for a score (within the scale's range).
 *
 * @param {number} score  - Score within the scale's range (e.g. 16 out of 20)
 * @returns {GradeBand|null}
 */
GradingScaleSchema.methods.resolveBand = function (score) {
  const s = parseFloat(parseFloat(score).toFixed(4));
  return this.bands.find((b) => s >= b.min && s <= b.max) || null;
};

/**
 * Converts a score to another scale.
 * Rounded to 2 decimal places to avoid floating-point noise.
 *
 * @param {number} score     - Score in the current scale
 * @param {number} targetMax - Target scale maximum (e.g. 100)
 * @returns {number}
 */
GradingScaleSchema.methods.convertTo = function (score, targetMax) {
  return parseFloat(((score / this.maxScore) * targetMax).toFixed(2));
};

/**
 * Returns true if the score is sufficient to pass.
 * Rounded before comparison.
 *
 * @param {number} score
 * @returns {boolean}
 */
GradingScaleSchema.methods.isPassing = function (score) {
  return parseFloat(parseFloat(score).toFixed(4)) >= this.passMark;
};

// ─── STATIC METHODS ───────────────────────────────────────────────────────────

/** Returns the active default grading scale for a campus. */
GradingScaleSchema.statics.getDefault = function (campusId) {
  return this.findOne({ schoolCampus: campusId, isDefault: true, isActive: true });
};

/**
 * Returns the most suitable grading scale for a campus.
 * Priority: isDefault → first active by creation date.
 *
 * @param {ObjectId} campusId
 * @returns {Promise<GradingScale|null>}
 */
GradingScaleSchema.statics.getForCampus = async function (campusId) {
  const def = await this.findOne({ schoolCampus: campusId, isDefault: true, isActive: true });
  if (def) return def;
  return this.findOne({ schoolCampus: campusId, isActive: true }).sort({ createdAt: 1 });
};

// ─── SERIALISATION ────────────────────────────────────────────────────────────

GradingScaleSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => { delete ret.__v; return ret; },
});

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  GradingScale: mongoose.model('GradingScale', GradingScaleSchema),
  GRADING_SYSTEM,
};