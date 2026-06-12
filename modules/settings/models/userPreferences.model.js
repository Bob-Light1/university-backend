const mongoose = require('mongoose');
const { Schema, Types: { ObjectId } } = mongoose;

const SUPPORTED_LANGUAGES = ['en', 'fr', 'es', 'ar', 'zh-CN', 'de'];
const SUPPORTED_TIMEZONES  = require('./timezone-whitelist');

const UserPreferencesSchema = new Schema(
  {
    // ── Identity & campus isolation ──────────────────────────────────────────
    userId: {
      type: ObjectId,
      required: true,
      unique: true,
      index: true,
    },
    userModel: {
      type: String,
      required: true,
      enum: ['Admin', 'Director', 'Campus', 'Teacher', 'Student', 'Parent', 'Mentor', 'Staff', 'Partner'],
    },
    campusId: {
      type: ObjectId,
      ref: 'Campus',
      default: null,
      index: true,
    },

    // ── Language & Region ─────────────────────────────────────────────────────
    preferredLanguage: {
      type: String,
      enum: SUPPORTED_LANGUAGES,
      default: 'en',
    },
    preferredLocale: {
      type: String,
      default: null, // e.g. 'fr-CM', 'en-NG'
      trim: true,
    },
    timezone: {
      type: String,
      default: 'UTC',
      validate: {
        validator: (tz) => SUPPORTED_TIMEZONES.includes(tz),
        message: 'Invalid IANA timezone',
      },
    },
    dateFormat: {
      type: String,
      enum: ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'],
      default: 'DD/MM/YYYY',
    },

    // ── Academic preferences ──────────────────────────────────────────────────
    gradeFormat: {
      type: String,
      enum: ['FRACTION', 'PERCENT', 'LETTER', 'GPA'],
      default: 'FRACTION',
    },

    // ── UI preferences (stored now, UI Phase 4) ───────────────────────────────
    theme: {
      type: String,
      enum: ['light', 'dark', 'system'],
      default: 'light',
    },
  },
  { timestamps: true }
);

// ── Campus isolation middleware ────────────────────────────────────────────────
UserPreferencesSchema.pre('find', function () {
  if (this._campusFilter) this.where({ campusId: this._campusFilter });
});

// ── Expose supported values as statics for use in controllers ─────────────────
UserPreferencesSchema.statics.SUPPORTED_LANGUAGES = SUPPORTED_LANGUAGES;
UserPreferencesSchema.statics.SUPPORTED_TIMEZONES  = SUPPORTED_TIMEZONES;

module.exports = mongoose.model('UserPreferences', UserPreferencesSchema);
