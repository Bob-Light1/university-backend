'use strict';

/**
 * @file document.service.js — inter-module API of the document domain (facade).
 *
 * ⚠️ Do not confuse with ./services/document.service.js (INTERNAL service:
 * search, listing). This file only exposes what other parts
 * of the application consume:
 *   - server.js : runRetentionJob (weekly retention cron)
 *   - server.js : shutdownPool (clean shutdown of the Puppeteer PDF pool)
 *   - academic-print : generateQrCodeDataUrl (verification QR on PDFs)
 *   - staff : listPublishedForCampus (published documents visible to staff)
 */

const { runRetentionJob }       = require('./document.retention.cron');
const { shutdownPool }          = require('./services/document.pdf.service');
const { generateQrCodeDataUrl } = require('./services/document.qr.service');
const repo                      = require('./document.repository');

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Paginated list of a campus's PUBLISHED documents (read-only).
 * @param {Object} p
 * @param {ObjectId|string} p.campusId
 * @param {number}  [p.page=1]
 * @param {number}  [p.limit=20]
 * @param {string}  [p.search]   — on title/description
 * @param {string}  [p.type]     — normalized to UPPERCASE
 * @param {string}  [p.category] — normalized to UPPERCASE
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
  return repo.paginatePublishedForCampus(filter, { skip, limit: Number(limit) });
};

module.exports = {
  runRetentionJob,
  shutdownPool,
  generateQrCodeDataUrl,
  listPublishedForCampus,
};
