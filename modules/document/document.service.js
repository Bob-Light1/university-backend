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
 *   - ai : listAiIngestables (ingestion feed §6.3.1) and
 *          authorizeAiCitations (answer-time re-authorization §4.5)
 */

const { runRetentionJob }       = require('./document.retention.cron');
const { shutdownPool }          = require('./services/document.pdf.service');
const { generateQrCodeDataUrl } = require('./services/document.qr.service');
const repo                      = require('./document.repository');
const { DOCUMENT_TYPE, DOCUMENT_STATUS } = require('./models/document.model');

// Lazy facades (both are require()d lazily everywhere in this module — course
// is already lazy in the access middleware, parent avoids any load-order cycle).
const courseService = () => require('../course').service;
const parentService = () => require('../parent').service;

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
  // deletedAt: null is mandatory — soft-deleted documents keep status PUBLISHED
  // and would otherwise leak into staff/public listings.
  const filter = { campusId, status: 'PUBLISHED', deletedAt: null };
  if (type)     filter.type     = type.toUpperCase();
  if (category) filter.category = category.toUpperCase();
  if (search) {
    const rx = new RegExp(escapeRegex(search.trim()), 'i');
    filter.$or = [{ title: rx }, { description: rx }];
  }

  const skip = (Number(page) - 1) * Number(limit);
  return repo.paginatePublishedForCampus(filter, { skip, limit: Number(limit) });
};

// ── AI internal read API (Phase 3, §6.2 / §6.3.1 of the design doc) ──────────

/**
 * Document types the AI may index (design D6): informational content only.
 * Personal documents (transcripts, payslips, contracts, badges, ID cards,
 * class lists) are NEVER vector-indexed — they are served on demand by the
 * internal API, which applies authorization at request time.
 */
const AI_INGESTABLE_TYPES = Object.freeze([
  DOCUMENT_TYPE.COURSE_MATERIAL,
  DOCUMENT_TYPE.ADMINISTRATIVE,
  DOCUMENT_TYPE.REPORT,
  DOCUMENT_TYPE.CUSTOM,
  DOCUMENT_TYPE.IMPORTED,
]);

/** Only published content is indexable; LOCKED is published + protected. */
const AI_INGESTABLE_STATUSES = Object.freeze([
  DOCUMENT_STATUS.PUBLISHED,
  DOCUMENT_STATUS.LOCKED,
]);

/**
 * Plain-text projection of one content block (rich body → indexable text).
 * Non-textual blocks (IMAGE, QR_CODE, DIVIDER, SIGNATURE_PLACEHOLDER) yield ''.
 */
const blockToText = (block) => {
  const c = block?.content || {};
  switch (block?.type) {
    case 'HEADING':
    case 'PARAGRAPH':
      return typeof c.text === 'string' ? c.text : '';
    case 'LIST':
      return Array.isArray(c.items) ? c.items.filter((i) => typeof i === 'string').join('\n') : '';
    case 'TABLE': {
      const headers = Array.isArray(c.headers) ? c.headers.join(' | ') : '';
      const rows = Array.isArray(c.rows)
        ? c.rows.map((r) => (Array.isArray(r) ? r.join(' | ') : '')).join('\n')
        : '';
      return [headers, rows].filter(Boolean).join('\n');
    }
    case 'CODE_BLOCK':
      return typeof c.code === 'string' ? c.code : '';
    default:
      return '';
  }
};

/** Full indexable text of a document: description + ordered body blocks + tags. */
const extractDocumentText = (doc) => {
  const parts = [doc.description || ''];
  const blocks = [...(doc.body || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const block of blocks) parts.push(blockToText(block));
  if (Array.isArray(doc.tags) && doc.tags.length) parts.push(`Tags: ${doc.tags.join(', ')}`);
  return parts.filter((s) => s && s.trim()).join('\n\n').trim();
};

/** Maps a document to the ingestable item contract (design doc, Annexe B). */
const toIngestable = (doc) => ({
  sourceType: 'document',
  sourceId: String(doc._id),
  version: String(doc.currentVersion || 1),
  campusId: String(doc.campusId),
  // Empty roles = readable by every campus role (same semantic as accessRoles).
  visibility: { roles: doc.accessRoles || [], ownerId: null },
  title: doc.title,
  text: extractDocumentText(doc),
  metadata: {
    type: doc.type,
    category: doc.category,
    ref: doc.ref,
    updatedAt: doc.updatedAt,
  },
});

/**
 * One page of the AI ingestion feed for a campus (§6.3.1): indexable documents
 * only (types D6, status published), stable (updatedAt, _id) ordering.
 * The opaque-cursor encoding is owned by the caller (ai module); this function
 * receives the decoded keyset position.
 *
 * @param {Object} p
 * @param {string}  p.campusId       - Mandatory campus scope (from the S2S token).
 * @param {Date}   [p.updatedAfter]  - Incremental reindex lower bound.
 * @param {Date}   [p.afterUpdatedAt] - Keyset cursor position (with afterId).
 * @param {string} [p.afterId]
 * @param {number}  p.limit          - Page size (already clamped ≤ 200 by the caller).
 * @param {string} [p.sourceId]      - Single-document fetch (event-driven ingestion).
 * @returns {Promise<{items: Object[], nextCursor: {updatedAt: Date, id: string}|null}>}
 */
const listAiIngestables = async ({ campusId, updatedAfter, afterUpdatedAt, afterId, limit, sourceId }) => {
  const filter = {
    campusId,
    deletedAt: null,
    status: { $in: AI_INGESTABLE_STATUSES },
    type: { $in: AI_INGESTABLE_TYPES },
  };
  if (sourceId) filter._id = sourceId;
  if (updatedAfter) filter.updatedAt = { $gte: updatedAfter };
  if (afterUpdatedAt && afterId) {
    filter.$or = [
      { updatedAt: { $gt: afterUpdatedAt } },
      { updatedAt: afterUpdatedAt, _id: { $gt: afterId } },
    ];
  }

  // limit + 1 sentinel row: detects a next page without a count query.
  const docs = await repo.findIngestableDocuments(filter, { limit: limit + 1 });
  const page = docs.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toIngestable),
    nextCursor: docs.length > limit && last
      ? { updatedAt: last.updatedAt, id: String(last._id) }
      : null,
  };
};

/**
 * Answer-time re-authorization of AI citations (§4.5) — mirrors the access
 * rules of the document routes (campus cross-check, TEACHER course scope,
 * STUDENT/PARENT linkage, accessRoles restriction). A source that stopped
 * being published (or was deleted) since indexing is NOT returned.
 *
 * @param {Object} ctx - Verified S2S context { userId, role, campusId }.
 * @param {string[]} sourceIds - Candidate document ids (already ObjectId-valid).
 * @returns {Promise<Array<{sourceType: string, sourceId: string, label: string, url: string}>>}
 */
const authorizeAiCitations = async ({ userId, role, campusId }, sourceIds) => {
  const globalRole = ['ADMIN', 'DIRECTOR'].includes(role);
  const docs = await repo.findCitationDocuments([...new Set(sourceIds.map(String))]);

  // PARENT: children resolved once from the parent module (never from the token).
  const childrenIds = role === 'PARENT'
    ? (await parentService().getChildrenIds(userId)).map(String)
    : null;

  const allowed = [];
  for (const doc of docs) {
    // Revocation: only currently-published content may be cited.
    if (!AI_INGESTABLE_STATUSES.includes(doc.status)) continue;
    // Campus cross-check (Layer 3 equivalent).
    if (!globalRole && String(doc.campusId) !== String(campusId)) continue;
    // accessRoles restriction (empty = all campus roles).
    if (!globalRole && Array.isArray(doc.accessRoles) && doc.accessRoles.length
        && !doc.accessRoles.includes(role)) continue;

    const studentLinks = (doc.linkedEntities || [])
      .filter((e) => e.entityType === 'Student')
      .map((e) => String(e.entityId));

    if (role === 'TEACHER') {
      // Same rule as enforceTeacherScope: COURSE_MATERIAL of their own courses.
      if (doc.type !== DOCUMENT_TYPE.COURSE_MATERIAL) continue;
      const courseIds = (doc.linkedEntities || [])
        .filter((e) => e.entityType === 'Course')
        .map((e) => e.entityId);
      if (courseIds.length === 0) continue;
      const owned = await courseService().isTeacherOfAnyCourse(courseIds, userId);
      if (!owned) continue;
    } else if (role === 'STUDENT') {
      if (!studentLinks.includes(String(userId))) continue;
    } else if (role === 'PARENT') {
      if (!studentLinks.some((id) => childrenIds.includes(id))) continue;
    }
    // ADMIN/DIRECTOR/CAMPUS_MANAGER/STAFF: campus + accessRoles checks suffice.

    allowed.push({
      sourceType: 'document',
      sourceId: String(doc._id),
      label: doc.title,
      url: `/documents/${doc._id}`,
    });
  }
  return allowed;
};

module.exports = {
  runRetentionJob,
  shutdownPool,
  generateQrCodeDataUrl,
  listPublishedForCampus,
  listAiIngestables,
  authorizeAiCitations,
};
