'use strict';

/** @file announcement.service.js @description Announcement workflow and nightly maintenance facade. */
const { runExpiryJob } = require('./announcement.expiry.cron');

module.exports = { runExpiryJob, ...require('./announcement.mutation.service') };
