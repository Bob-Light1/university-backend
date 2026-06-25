'use strict';

const mongoose = require('mongoose');
const bcrypt   = require('bcrypt');

const SALT_ROUNDS = 12;

const NotificationPrefsSchema = new mongoose.Schema(
  {
    email: { type: Boolean, default: true  },
    sms:   { type: Boolean, default: false },
    push:  { type: Boolean, default: false },
  },
  { _id: false }
);

/**
 * Mentor Schema
 * Represents a mentor responsible for personalised student follow-up.
 * Created and managed by a CAMPUS_MANAGER; campus-scoped.
 */
const mentorSchema = new mongoose.Schema(
  {
    // ─── Campus assignment ────────────────────────────────────────────────────
    schoolCampus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Campus',
      required: [true, 'Campus is required'],
      index:    true,
    },

    // ─── Classes and students under this mentor's care ────────────────────────
    classes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Classes', index: true }],
    students: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student', index: true }],

    // ─── Personal information ─────────────────────────────────────────────────
    firstName: {
      type:      String,
      required:  [true, 'First name is required'],
      trim:      true,
      minlength: [2, 'First name must be at least 2 characters'],
      maxlength: [50, 'First name must not exceed 50 characters'],
    },

    lastName: {
      type:      String,
      required:  [true, 'Last name is required'],
      trim:      true,
      minlength: [2, 'Last name must be at least 2 characters'],
      maxlength: [50, 'Last name must not exceed 50 characters'],
    },

    // ─── Contact & authentication ─────────────────────────────────────────────
    username: {
      type:      String,
      required:  [true, 'Username is required'],
      unique:    true,
      lowercase: true,
      trim:      true,
      index:     true,
      minlength: [3, 'Username must be at least 3 characters'],
      maxlength: [30, 'Username must not exceed 30 characters'],
      match: [
        /^[a-z0-9_.-]+$/,
        'Username can only contain lowercase letters, numbers, dots, hyphens and underscores',
      ],
    },

    email: {
      type:      String,
      lowercase: true,
      trim:      true,
      unique:    true,
      sparse:    true,
      match: [
        /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
        'Please enter a valid email address',
      ],
    },

    phone: {
      type:   String,
      trim:   true,
      unique: true,
      sparse: true,
      match:  [/^\+?[0-9\s()-]{6,20}$/, 'Please enter a valid phone number'],
    },

    password: {
      type:     String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select:   false,
    },

    // ─── Role ─────────────────────────────────────────────────────────────────
    role: { type: String, default: 'MENTOR' },

    // ─── Profile ──────────────────────────────────────────────────────────────
    profileImage:  { type: String, trim: true, default: null },
    specialization: { type: String, maxlength: 200 },

    // ─── Status & audit ───────────────────────────────────────────────────────
    status: {
      type:    String,
      enum:    ['pending', 'active', 'inactive', 'suspended', 'archived'],
      default: 'active',
      index:   true,
    },

    lastLogin: { type: Date, default: null },

    notificationPrefs: {
      type:    NotificationPrefsSchema,
      default: () => ({ email: true, sms: false, push: false }),
    },
  },
  {
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────
mentorSchema.index({ schoolCampus: 1, status: 1 });
mentorSchema.index({ firstName: 1, lastName: 1 });

// ─── Virtuals ─────────────────────────────────────────────────────────────────
mentorSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

// ─── Pre-save: hash password ──────────────────────────────────────────────────
mentorSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  try {
    this.password = await bcrypt.hash(this.password, SALT_ROUNDS);
    next();
  } catch (err) {
    next(err);
  }
});

// ─── Instance method ──────────────────────────────────────────────────────────
mentorSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model('Mentor', mentorSchema);
