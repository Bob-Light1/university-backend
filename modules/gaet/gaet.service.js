/**
 * @file gaet.service.js
 * @description Public API of the GAET module for the rest of the application.
 *  (Architecture rule: other modules / server.js NEVER touch this module's
 *   models directly — see MODULAR_MONOLITH_MIGRATION.md §3.)
 *
 *  All persistence goes through gaet.repository (step 0 of the pre-Postgres prep).
 */

const gaetRepo = require('./gaet.repository');
const { shutdownQueue } = require('./gaet.queue');

const ZOMBIE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Recovers zombie generation jobs (left in GENERATING after a server
 * crash/restart) and moves them to FAILED so the campus manager can cleanly
 * relaunch. Called by server.js at startup, once the MongoDB connection is
 * established.
 *
 * @returns {Promise<number>} number of jobs recovered
 */
function recoverZombieJobs() {
  return gaetRepo.recoverZombies(ZOMBIE_THRESHOLD_MS);
}

module.exports = {
  recoverZombieJobs,
  shutdownQueue,
};
