'use strict';

const mongoose = require('mongoose');
const { ALL_PERMISSIONS } = require('../constants/staff-permissions');

/**
 * StaffRole Schema
 * Represents a campus-scoped sub-role template (e.g. "Accountant", "Secretary").
 * A CAMPUS_MANAGER creates these, assigns permissions to them, then attaches
 * them to individual Staff accounts.  The Staff member's JWT will carry the
 * permission array at login — no DB lookup needed per request.
 */
const staffRoleSchema = new mongoose.Schema(
  {
    // ─── Campus scope ─────────────────────────────────────────────────────────
    campus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'SchoolCampus',
      required: [true, 'Campus is required'],
      index:    true,
    },

    // ─── Identity ─────────────────────────────────────────────────────────────
    name: {
      type:      String,
      required:  [true, 'Role name is required'],
      trim:      true,
      minlength: [2, 'Role name must be at least 2 characters'],
      maxlength: [60, 'Role name must not exceed 60 characters'],
    },

    description: {
      type:     String,
      trim:     true,
      maxlength: [200, 'Description must not exceed 200 characters'],
    },

    // ─── Permissions ─────────────────────────────────────────────────────────
    permissions: {
      type:     [String],
      default:  [],
      validate: {
        validator: (perms) => perms.every((p) => ALL_PERMISSIONS.includes(p)),
        message:   'One or more permission keys are invalid.',
      },
    },

    // ─── Status ───────────────────────────────────────────────────────────────
    isActive: { type: Boolean, default: true, index: true },

    // ─── Audit ────────────────────────────────────────────────────────────────
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'Admin',
    },
  },
  {
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ─── Compound unique index: one role name per campus ─────────────────────────
staffRoleSchema.index({ campus: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('StaffRole', staffRoleSchema);
