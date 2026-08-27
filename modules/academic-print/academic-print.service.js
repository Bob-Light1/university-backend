'use strict';

/**
 * @file academic-print.service.js — inter-module API of the academic-print domain (facade).
 *
 * Current consumers:
 *   - server.js : shutdownAcademicPool (graceful Puppeteer pool shutdown)
 *   - server.js (cron) : runPrintQueueJob (sweep the persisted print job queue)
 *   - modules/document (retention cron) : cleanupExpiredPrintFiles
 *   - modules/finance (fee receipt) : renderPdf + getCampusBranding
 *
 * WHY THE RENDERING PRIMITIVE IS EXPORTED, AND NOT A `RECEIPT` DOCUMENT TYPE
 * What this module owns and nobody should own twice is the RESOURCE: one
 * Puppeteer browser for the process, a FIFO cap on simultaneous pages, and a
 * branding cache. A second pool opened by another module would double the Chrome
 * footprint, ignore that cap, and escape `shutdownAcademicPool()` — so the
 * graceful shutdown in `server.js` would leave a browser behind.
 *
 * What it does NOT own is a fee receipt: it is an accounting artefact whose
 * wording, layout and rules belong to the finance module, and adding it to
 * `generateAcademicPdf`'s six academic types would make this module import
 * finance's vocabulary to print a document it has no opinion about.
 */

const {
  shutdownAcademicPool,
  cleanupExpiredPrintFiles,
  renderPdf,
  getCampusBranding,
} = require('./academic-pdf.service');
const { runPrintQueueJob } = require('./print-job.processor');

module.exports = {
  shutdownAcademicPool,
  cleanupExpiredPrintFiles,
  runPrintQueueJob,
  renderPdf,          // (html, { format, landscape, margins }) → Buffer
  getCampusBranding,  // (campusId) → { campus_name, location, logoDataUrl }
};
