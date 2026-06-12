'use strict';

/**
 * @file document.service.js — API inter-modules du domaine document (façade).
 *
 * ⚠️ Ne pas confondre avec ./services/document.service.js (service INTERNE :
 * recherche, listing). Ce fichier-ci n'expose que ce que les autres parties
 * de l'application consomment :
 *   - server.js : runRetentionJob (cron hebdomadaire de rétention)
 *   - server.js : shutdownPool (arrêt propre du pool Puppeteer PDF)
 *   - academic-print : generateQrCodeDataUrl (QR de vérification sur les PDF)
 */

const { runRetentionJob }       = require('./document.retention.cron');
const { shutdownPool }          = require('./services/document.pdf.service');
const { generateQrCodeDataUrl } = require('./services/document.qr.service');

module.exports = {
  runRetentionJob,
  shutdownPool,
  generateQrCodeDataUrl,
};
