'use strict';

const mongoose = require('mongoose');

// Stores per-user read receipts for announcements.
// Created when a user marks an announcement as read (lazy — no fan-out on publish).
const userNotificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    announcement: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Announcement',
      required: true,
    },
    schoolCampus: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SchoolCampus',
      required: true,
    },
    readAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

// One read-receipt per user per announcement
userNotificationSchema.index({ userId: 1, announcement: 1 }, { unique: true });
// For "mark all as read" and unread-count queries
userNotificationSchema.index({ userId: 1, schoolCampus: 1 });

module.exports = mongoose.model('UserNotification', userNotificationSchema);
