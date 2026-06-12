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
 *   - staff : listPublishedForCampus (documents publiés visibles par le staff)
 */

const { runRetentionJob }       = require('./document.retention.cron');
const { shutdownPool }          = require('./services/document.pdf.service');
const { generateQrCodeDataUrl } = require('./services/document.qr.service');
const Document                  = require('./models/document.model');

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Liste paginée des documents PUBLISHED d'un campus (lecture seule).
 * @param {Object} p
 * @param {ObjectId|string} p.campusId
 * @param {number}  [p.page=1]
 * @param {number}  [p.limit=20]
 * @param {string}  [p.search]   — sur title/description
 * @param {string}  [p.type]     — normalisé en MAJUSCULES
 * @param {string}  [p.category] — normalisé en MAJUSCULES
 * @returns {Promise<{docs: Object[], total: number}>}
 */
const listPublishedForCampus = async ({ campusId, page = 1, limit = 20, search, type, category }) => {
  const filter = { campusId, status: 'PUBLISHED' };
  if (type)     filter.type     = type.toUpperCase();
  if (category) filter.category = category.toUpperCase();
  if (search) {
    const rx = new RegExp(escapeRegex(search.trim()), 'i');
    filter.$or = [{ title: rx }, { description: rx }];
  }

  const skip = (Number(page) - 1) * Number(limit);
  const [docs, total] = await Promise.all([
    Document.find(filter)
      .select('-__v -auditLog -versions')
      .sort({ createdAt: -1 })
      .skip(skip).limit(Number(limit)).lean(),
    Document.countDocuments(filter),
  ]);
  return { docs, total };
};

module.exports = {
  runRetentionJob,
  shutdownPool,
  generateQrCodeDataUrl,
  listPublishedForCampus,
};
