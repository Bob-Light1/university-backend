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
 *  - timestamps (createdAt / updatedAt) are enabled for audit trails.
 */

const mongoose = require('mongoose');

// ─── ENUMS ────────────────────────────────────────────────────────────────────

const ADMIN_ROLES    = Object.freeze(['ADMIN', 'DIRECTOR']);
const ADMIN_STATUSES = Object.freeze(['active', 'inactive', 'suspended']);

// ─── SCHEMA ───────────────────────────────────────────────────────────────────

const adminSchema = new mongoose.Schema(
  {
    admin_name: {
      type:     String,
      required: [true, 'Admin name is required'],
      trim:     true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [100, 'Name must not exceed 100 characters'],
    },

    email: {
      type:      String,
      required:  [true, 'Email is required'],
      unique:    true,
      lowercase: true,
      trim:      true,
      match:     [/^\S+@\S+\.\S+$/, 'Invalid email format'],
      index:     true,
    },

    password: {
      type:     String,
      required: [true, 'Password is required'],
      select:   false, // Never returned in queries unless explicitly requested
    },

    /**
     * Role determines the permission level in the application.
     * ADMIN    — full platform access.
     * DIRECTOR — broad access, typically restricted from destructive operations.
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

    lastLogin: {
      type: Date,
    },

    profileImage: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt automatically
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  },
);

// ─── INDEXES ──────────────────────────────────────────────────────────────────

adminSchema.index({ role: 1, status: 1 });

// ─── MODEL ────────────────────────────────────────────────────────────────────

module.exports = mongoose.model('Admin', adminSchema);
module.exports.ADMIN_ROLES    = ADMIN_ROLES;
module.exports.ADMIN_STATUSES = ADMIN_STATUSES;