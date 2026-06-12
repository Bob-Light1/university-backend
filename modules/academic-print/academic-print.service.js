'use strict';

/**
 * @file academic-print.service.js — API inter-modules du domaine academic-print (façade).
 *
 * Consommateurs actuels :
 *   - server.js : shutdownAcademicPool (arrêt propre du pool Puppeteer)
 *   - modules/document (cron rétention) : cleanupExpiredPrintFiles
 */

const { shutdownAcademicPool, cleanupExpiredPrintFiles } = require('./academic-pdf.service');

module.exports = {
  shutdownAcademicPool,
  cleanupExpiredPrintFiles,
};
