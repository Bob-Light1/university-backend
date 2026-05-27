'use strict';

/**
 * @file admin.model.js
 * @description Mongoose model for platform-level Admin and Director accounts.
 *
 * Security notes:
 *  - password field is excluded from all queries by default (select: false).
 *  - email is normalised to lowercase at the model level.
 *  - role is constrained to ADMIN | DIRECTOR — no other value can be stored.
 *  - status allows soft-disabling an account without deletion.
 *  - isBootstrap marks the very first account created (cannot be suspended).
 *  - createdBy records which admin created this account (null = bootstrap).
 *  - statusHistory provides a full audit trail of every status change.
 *  - timestamps (createdAt / updatedAt) are enabled for audit trails.
 */

const mongoose = require('mongoose');

// ─── ENUMS ────────────────────────────────────────────────────────────────────

const ADMIN_ROLES    = Object.freeze(['ADMIN', 'DIRECTOR']);
const ADMIN_STATUSES = Object.freeze(['active', 'inactive', 'suspended']);

// ─── SUB-SCHEMA: STATUS HISTORY ───────────────────────────────────────────────

const statusHistorySchema = new mongoose.Schema(
  {
    status:    { type: String, enum: ADMIN_STATUSES, required: true },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    changedAt: { type: Date, default: () => new Date() },
    note:      { type: String, trim: true, maxlength: 300, default: null },
  },
  { _id: false },
);

// ─── SCHEMA ───────────────────────────────────────────────────────────────────

const adminSchema = new mongoose.Schema(
  {
    admin_name: {
      type:      String,
      required:  [true, 'Admin name is required'],
      trim:      true,
      minlength: [2,   'Name must be at least 2 characters'],
      maxlength: [100, 'Name must not exceed 100 characters'],
    },

    email: {
      type:      String,
      required:  [true, 'Email is required'],
      unique:    true,
      lowercase: true,
      trim:      true,
      match:     [/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, 'Invalid email format'],
      index:     true,
    },

    password: {
      type:     String,
      required: [true, 'Password is required'],
      select:   false,
    },

    /**
     * ADMIN    — full platform access (can create accounts, change statuses).
     * DIRECTOR — oversight and reporting only.
     */
    role: {
      type:    String,
      enum:    { values: ADMIN_ROLES, message: '{VALUE} is not a valid role' },
      default: 'ADMIN',
      index:   true,
    },

    status: {
      type:    String,
      enum:    { values: ADMIN_STATUSES, message: '{VALUE} is not a valid status' },
      default: 'active',
      index:   true,
    },

    /**
     * True only for the very first account created (bootstrap).
     * This account cannot be suspended or deactivated via the API.
     */
    isBootstrap: {
      type:    Boolean,
      default: false,
      index:   true,
    },

    /**
     * The Admin who created this account.
     * Null means the account was self-created during bootstrap.
     */
    createdBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'Admin',
      default: null,
    },

    /**
     * Full audit trail of every status change.
     * The initial 'active' entry is written at creation time.
     */
    statusHistory: {
      type:    [statusHistorySchema],
      default: [],
    },

    lastLogin: {
      type: Date,
    },

    profileImage: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  },
);

// ─── INDEXES ──────────────────────────────────────────────────────────────────

adminSchema.index({ role: 1, status: 1 });
// isBootstrap: single-field index already declared via `index: true` on the field.

// ─── MODEL ────────────────────────────────────────────────────────────────────

module.exports = mongoose.model('Admin', adminSchema);
module.exports.ADMIN_ROLES    = ADMIN_ROLES;
module.exports.ADMIN_STATUSES = ADMIN_STATUSES;
