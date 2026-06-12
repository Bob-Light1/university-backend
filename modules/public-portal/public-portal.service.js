'use strict';

/**
 * @file public-portal.service.js — API inter-modules du domaine public-portal.
 *
 * Exposé via la façade (index.js). Consommateurs actuels :
 *   - server.js : planification du cron de clôture des compétitions mensuelles.
 *
 * notifyWinners reste interne au module (seul le cron l'utilise).
 */

const { runCompetitionClosingJob } = require('./competition.closing.cron');

module.exports = {
  runCompetitionClosingJob,
};
