'use strict';

const announcementRepo = require('./announcement.repository');

/**
 * Runs nightly to:
 * 1. Archive published announcements whose expiresAt is in the past.
 * 2. Un-pin announcements whose pinnedUntil date has passed.
 */
const runExpiryJob = async () => {
  try {
    const now = new Date();

    const expired = await announcementRepo.archiveExpired(now);
    if (expired > 0) {
      console.log(`📢 Announcement expiry: archived ${expired} expired announcement(s).`);
    }

    const unpinned = await announcementRepo.unpinExpired(now);
    if (unpinned > 0) {
      console.log(`📢 Announcement expiry: unpinned ${unpinned} announcement(s).`);
    }
  } catch (err) {
    console.error('❌ Announcement expiry cron error:', err.message);
  }
};

module.exports = { runExpiryJob };
