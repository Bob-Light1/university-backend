'use strict';

const mongoose = require('mongoose');

const ROLES = [
  'STUDENT', 'TEACHER', 'PARENT', 'PARTNER',
  'STAFF', 'MENTOR', 'CAMPUS_MANAGER', 'DIRECTOR', 'ADMIN', 'ALL',
];

const announcementSchema = new mongoose.Schema(
  {
    schoolCampus: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Campus',
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150,
    },
    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: 3000,
    },
    type: {
      type: String,
      enum: ['info', 'warning', 'urgent', 'event'],
      default: 'info',
    },
    // Roles that can see this announcement. 'ALL' means every authenticated user on the campus.
    targetRoles: {
      type: [{ type: String, enum: ROLES }],
      default: ['ALL'],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: 'At least one target role is required.',
      },
    },
    pinned: { type: Boolean, default: false },
    // Automatic un-pin date (optional)
    pinnedUntil: { type: Date, default: null },

    status: {
      type: String,
      enum: ['draft', 'published', 'archived'],
      default: 'draft',
    },
    expiresAt:   { type: Date, default: null },
    publishedAt: { type: Date, default: null },
    archivedAt:  { type: Date, default: null },
    deletedAt:   { type: Date, default: null },

    createdBy: {
      userId: { type: mongoose.Schema.Types.ObjectId },
      role:   { type: String },
      name:   { type: String, trim: true },
    },
  },
  { timestamps: true }
);

// Queries: admin list filtered by campus + status
announcementSchema.index({ schoolCampus: 1, status: 1, deletedAt: 1 });
// Queries: user inbox filtered by campus + role + sort
announcementSchema.index({ schoolCampus: 1, status: 1, targetRoles: 1, pinned: -1, publishedAt: -1 });
// Cron expiry sweep
announcementSchema.index({ expiresAt: 1, status: 1 });

module.exports = mongoose.model('Announcement', announcementSchema);
