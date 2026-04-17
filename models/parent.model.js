'use strict';

/**
 * @file parent.model.js
 * @description Mongoose model for the Parent Management Module.
 *
 *  Conventions:
 *  ─────────────────────────────────────────────────────────────────────────
 *  • Campus isolation  : schoolCampus (ObjectId → 'Campus')
 *  • Password          : bcrypt hash (salt=12), select:false
 *  • children[]        : source of truth for parent-child relationship (max 10)
 *  • parentRef         : auto-generated PAR-YYYY-NNNNN via counter.model.js
 *  • Soft-delete       : isArchived boolean (not a status value)
 *  • Status            : active | inactive | suspended  (NOT archived)
 */

const mongoose = require('mongoose');
const bcrypt   = require('bcrypt');

const SALT_ROUNDS = 12;

// ── SUB-SCHEMAS ───────────────────────────────────────────────────────────────

const AddressSchema = new mongoose.Schema(
  {
    street:     { type: String, trim: true, default: null },
    city:       { type: String, trim: true, default: null },
    state:      { type: String, trim: true, default: null },
    country:    { type: String, trim: true, default: null },
    postalCode: { type: String, trim: true, default: null },
  },
  { _id: false }
);

const NotificationPrefsSchema = new mongoose.Schema(
  {
    email: { type: Boolean, default: true  },
    sms:   { type: Boolean, default: false },
    push:  { type: Boolean, default: false },
  },
  { _id: false }
);

// ── MAIN SCHEMA ───────────────────────────────────────────────────────────────

const parentSchema = new mongoose.Schema(
  {
    // ── PERSONAL INFORMATION ──────────────────────────────────────────────
    firstName: {
      type:      String,
      required:  [true, 'First name is required'],
      trim:      true,
      minlength: [2,  'First name must be at least 2 characters'],
      maxlength: [50, 'First name must not exceed 50 characters'],
    },

    lastName: {
      type:      String,
      required:  [true, 'Last name is required'],
      trim:      true,
      minlength: [2,  'Last name must be at least 2 characters'],
      maxlength: [50, 'Last name must not exceed 50 characters'],
    },

    // ── CONTACT / AUTHENTICATION ──────────────────────────────────────────
    email: {
      type:     String,
      required: [true, 'Email is required'],
      unique:   true,
      lowercase: true,
      trim:     true,
      match:    [
        /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
        'Please enter a valid email address',
      ],
    },

    phone: {
      type:     String,
      required: [true, 'Phone number is required'],
      trim:     true,
      match:    [
        /^\+?[0-9\s()-]{6,20}$/,
        'Please enter a valid phone number',
      ],
    },

    password: {
      type:      String,
      required:  [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select:    false, // NEVER returned in queries by default
    },

    // ── PROFILE ───────────────────────────────────────────────────────────
    gender: {
      type:     String,
      enum:     { values: ['male', 'female'], message: '{VALUE} is not a valid gender' },
      required: [true, 'Gender is required'],
    },

    dateOfBirth: {
      type:    Date,
      default: null,
      validate: {
        validator: function (v) { return !v || v < new Date(); },
        message:   'Date of birth cannot be in the future',
      },
    },

    nationalId: {
      type:      String,
      trim:      true,
      uppercase: true,
      maxlength: [50, 'National ID must not exceed 50 characters'],
      default:   null,
    },

    occupation: {
      type:      String,
      trim:      true,
      maxlength: [100, 'Occupation must not exceed 100 characters'],
      default:   null,
    },

    address: {
      type:    AddressSchema,
      default: null,
    },

    profileImage: {
      type:    String,
      default: null,
    },

    // ── CAMPUS & CHILDREN ─────────────────────────────────────────────────
    schoolCampus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Campus',
      required: [true, 'Campus is required'],
      index:    true,
    },

    /**
     * Source of truth for the parent-child relationship.
     * Student model is NOT modified when children[] changes.
     * Maximum 10 entries enforced by pre-validate (dashboard perf cap).
     */
    children: {
      type:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }],
      default: [],
      validate: {
        validator: function (v) { return Array.isArray(v) && v.length <= 10; },
        message:   'A parent cannot have more than 10 children linked.',
      },
    },

    relationship: {
      type:     String,
      enum:     {
        values:  ['father', 'mother', 'guardian', 'other'],
        message: '{VALUE} is not a valid relationship',
      },
      required: [true, 'Relationship is required'],
    },

    // ── STATUS & PREFERENCES ──────────────────────────────────────────────
    status: {
      type:    String,
      enum:    {
        values:  ['active', 'inactive', 'suspended'],
        message: '{VALUE} is not a valid status',
      },
      default: 'active',
      index:   true,
    },

    preferredLanguage: {
      type:    String,
      enum:    { values: ['fr', 'en', 'es', 'ar'], message: '{VALUE} is not a valid language' },
      default: 'fr',
    },

    notificationPrefs: {
      type:    NotificationPrefsSchema,
      default: () => ({ email: true, sms: false, push: false }),
    },

    // ── METADATA ──────────────────────────────────────────────────────────
    lastLogin: {
      type:    Date,
      default: null,
    },

    /**
     * Internal admin notes. Max 500 chars.
     * NEVER visible to the parent themselves.
     */
    notes: {
      type:      String,
      trim:      true,
      maxlength: [500, 'Notes must not exceed 500 characters'],
      default:   null,
    },

    /**
     * Soft-delete flag. isArchived:true removes the parent from all
     * default list queries. Hard delete available to ADMIN only.
     */
    isArchived: {
      type:    Boolean,
      default: false,
    },

    /**
     * Human-readable reference: PAR-YYYY-NNNNN
     * Auto-generated in pre-save via counter.model.js.
     * Required — never supplied by the caller.
     */
    parentRef: {
      type:    String,
      unique:  true,
      sparse:  true, // allows null during validation before pre-save sets the value
      trim:    true,
    },
  },

  {
    timestamps: true,               // createdAt, updatedAt
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ── COMPOUND INDEXES ──────────────────────────────────────────────────────────
parentSchema.index({ schoolCampus: 1, status: 1 });
parentSchema.index({ schoolCampus: 1, firstName: 1, lastName: 1 });
parentSchema.index({ children: 1 });
// Partial index: only index documents where isArchived is false
parentSchema.index(
  { isArchived: 1 },
  { partialFilterExpression: { isArchived: false } }
);

// ── VIRTUAL ───────────────────────────────────────────────────────────────────
parentSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

// ── PRE-SAVE MIDDLEWARE ───────────────────────────────────────────────────────
parentSchema.pre('save', async function (next) {
  try {
    // Normalize email
    if (this.email) this.email = this.email.toLowerCase().trim();

    // Uppercase nationalId
    if (this.nationalId) this.nationalId = this.nationalId.toUpperCase().trim();

    // Hash password only when it has been modified
    if (this.isModified('password')) {
      const salt    = await bcrypt.genSalt(SALT_ROUNDS);
      this.password = await bcrypt.hash(this.password, salt);
    }

    // Auto-generate parentRef on first save
    if (!this.parentRef) {
      const { nextSequence } = require('./counter.model');
      const year      = new Date().getFullYear();
      const seq       = await nextSequence(`parent_ref_${year}`);
      this.parentRef  = `PAR-${year}-${String(seq).padStart(5, '0')}`;
    }

    next();
  } catch (err) {
    next(err);
  }
});

// ── PRE-VALIDATE MIDDLEWARE ───────────────────────────────────────────────────
/**
 * Verifies that every ObjectId in children[] belongs to schoolCampus.
 * Also enforces the hard cap of 10 children (dashboard performance).
 * Prevents cross-campus child injection.
 */
parentSchema.pre('validate', async function () {
  // Only run when children or campus changed
  if (!this.isModified('children') && !this.isNew) return;
  if (!this.children || this.children.length === 0) return;
  if (!this.schoolCampus) return;

  if (this.children.length > 10) {
    this.invalidate('children', 'A parent cannot have more than 10 children linked.', this.children);
    return;
  }

  try {
    const Student   = mongoose.model('Student');
    const campusStr = this.schoolCampus.toString();

    const students = await Student.find({ _id: { $in: this.children } })
      .select('schoolCampus')
      .lean();

    for (const s of students) {
      if (!s.schoolCampus || s.schoolCampus.toString() !== campusStr) {
        this.invalidate(
          'children',
          `Student ${s._id} does not belong to this campus.`,
          s._id
        );
      }
    }
  } catch {
    // Lookup errors must not block the save — validation continues
  }
});

// ── INSTANCE METHODS ──────────────────────────────────────────────────────────

/**
 * Returns true only when the parent account is active.
 * Called in loginParent before issuing the JWT.
 */
parentSchema.methods.canLogin = function () {
  return this.status === 'active';
};

// ── MODEL ─────────────────────────────────────────────────────────────────────

const Parent = mongoose.model('Parent', parentSchema);
module.exports = Parent;
