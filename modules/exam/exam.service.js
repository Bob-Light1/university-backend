'use strict';

/**
 * @file exam.service.js — API inter-modules du domaine exam (façade).
 *
 * Consommateurs actuels :
 *   - server.js : runAntiCheatJob (cron nocturne d'analyse anti-triche)
 *
 * Les dashboards teacher/student et staff.readonly accèdent encore aux models
 * exam via les shims de models/exam-models/ — à remplacer par des fonctions
 * de service ici lors de la phase nettoyage.
 */

const { runAntiCheatJob } = require('./exam-anticheat.cron');

module.exports = {
  runAntiCheatJob,
};
