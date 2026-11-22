'use strict';

/** @file announcement.expiry.cron.js @description Nightly transactional expiry and automatic unpinning. */
const mutations = require('./announcement.mutation.service');

/**
 * Runs nightly to:
 * 1. Archive published announcements whose expiresAt is in the past.
 * 2. Un-pin announcements whose pinnedUntil date has passed.
 */
const runExpiryJob = async () => {
  try {
    const now = new Date();

    const expired = await mutations.archiveExpired(now);
    if (expired > 0) {
      console.log(`📢 Announcement expiry: archived ${expired} expired announcement(s).`);
    }

    const unpinned = await mutations.unpinExpired(now);
    if (unpinned > 0) {
      console.log(`📢 Announcement expiry: unpinned ${unpinned} announcement(s).`);
    }
  } catch (err) {
    console.error('Announcement expiry cron error:', err.message, { operation: err.operation, committedCount: err.committedCount });
  }
};

module.exports = { runExpiryJob };
