'use strict';

const Announcement = require('../models/announcement.model');

/**
 * Runs nightly to:
 * 1. Archive published announcements whose expiresAt is in the past.
 * 2. Un-pin announcements whose pinnedUntil date has passed.
 */
const runExpiryJob = async () => {
  try {
    const now = new Date();

    const expireResult = await Announcement.updateMany(
      {
        status:    'published',
        deletedAt: null,
        expiresAt: { $ne: null, $lte: now },
      },
      { $set: { status: 'archived', archivedAt: now } }
    );

    if (expireResult.modifiedCount > 0) {
      console.log(`📢 Announcement expiry: archived ${expireResult.modifiedCount} expired announcement(s).`);
    }

    const unpinResult = await Announcement.updateMany(
      {
        pinned:      true,
        deletedAt:   null,
        pinnedUntil: { $ne: null, $lte: now },
      },
      { $set: { pinned: false, pinnedUntil: null } }
    );

    if (unpinResult.modifiedCount > 0) {
      console.log(`📢 Announcement expiry: unpinned ${unpinResult.modifiedCount} announcement(s).`);
    }
  } catch (err) {
    console.error('❌ Announcement expiry cron error:', err.message);
  }
};

module.exports = { runExpiryJob };
