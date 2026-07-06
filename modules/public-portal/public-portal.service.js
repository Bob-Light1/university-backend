'use strict';

/**
 * @file public-portal.service.js — API inter-modules du domaine public-portal.
 *
 * Exposé via la façade (index.js). Consommateurs actuels :
 *   - server.js : planification du cron de clôture des compétitions mensuelles.
 *   - ai        : listAiIngestables (public corpus ingestion feed §6.3.1) and
 *                 authorizeAiCitations (answer-time re-authorization §4.5) for
 *                 the portal programmes/FAQ vectorial source (D6 2nd increment).
 *
 * notifyWinners reste interne au module (seul le cron l'utilise).
 */

const { runCompetitionClosingJob } = require('./competition.closing.cron');
const { shutdownIngestionQueue }   = require('./public-portal.queue');
const repo = require('./public-portal.repository');
const { AI_SOURCE_TYPES } = require('../../shared/constants/ai.constants');

// ── AI ingestion of the public portal corpus (Phase 3, §6.3.1 / §4.5) ────────

/**
 * Concatenate a bilingual {fr, en} content field into a single indexable text
 * block (French then English) — both languages are embedded so a query in
 * either language recalls the source.
 */
const bilingualText = (field) => {
  if (!field || typeof field !== 'object') return '';
  return [field.fr, field.en]
    .filter((s) => typeof s === 'string' && s.trim())
    .join('\n\n');
};

/**
 * Primary-language value of a bilingual {fr, en} field (French, English
 * fallback) — used for the display title / citation label, while the indexable
 * text keeps both languages for recall.
 */
const primaryText = (field) => {
  if (!field || typeof field !== 'object') return '';
  return (typeof field.fr === 'string' && field.fr.trim())
    ? field.fr
    : (typeof field.en === 'string' ? field.en : '');
};

/**
 * Maps a CoursePreview (programme excerpt) to the ingestable item contract
 * (Annexe B). The version is the updatedAt epoch: it changes on every edit, so
 * ai-service prunes stale chunks deterministically (§6.3 idempotence).
 * visibility.roles = [] marks PUBLIC content — visible to every campus role.
 */
const coursePreviewToIngestable = (doc) => ({
  sourceType: AI_SOURCE_TYPES.PORTAL_PROGRAM,
  sourceId: String(doc._id),
  version: String(new Date(doc.updatedAt).getTime()),
  campusId: String(doc.schoolCampus),
  visibility: { roles: [], ownerId: null },
  title: primaryText(doc.title) || doc.program || '',
  text: [doc.program ? `Program: ${doc.program}` : '', bilingualText(doc.content)]
    .filter(Boolean)
    .join('\n\n'),
  metadata: { kind: 'course-preview', program: doc.program, updatedAt: doc.updatedAt },
});

/** Maps a FaqEntry to the ingestable item contract (Annexe B). Public corpus. */
const faqToIngestable = (doc) => ({
  sourceType: AI_SOURCE_TYPES.PORTAL_FAQ,
  sourceId: String(doc._id),
  version: String(new Date(doc.updatedAt).getTime()),
  campusId: String(doc.schoolCampus),
  visibility: { roles: [], ownerId: null },
  title: primaryText(doc.question),
  text: [bilingualText(doc.question), bilingualText(doc.answer)].filter(Boolean).join('\n\n'),
  metadata: { kind: 'faq', category: doc.category, updatedAt: doc.updatedAt },
});

/** Portal source type → ingestable mapper (also the ingestable-type whitelist). */
const INGESTABLE_MAPPERS = Object.freeze({
  [AI_SOURCE_TYPES.PORTAL_PROGRAM]: coursePreviewToIngestable,
  [AI_SOURCE_TYPES.PORTAL_FAQ]:     faqToIngestable,
});

/** Human-readable citation label for a re-authorized portal source. */
const citationLabel = (sourceType, doc) =>
  sourceType === AI_SOURCE_TYPES.PORTAL_FAQ
    ? (doc.question?.fr || doc.question?.en || 'FAQ')
    : (doc.title?.fr || doc.title?.en || doc.program || 'Program');

/**
 * One page of the AI ingestion feed for a portal source type (§6.3.1): PUBLISHED
 * programmes/FAQ only, campus-scoped, stable (updatedAt, _id) ordering. The
 * opaque-cursor encoding is owned by the caller (ai module); this function
 * receives the decoded keyset position — same contract as document.listAiIngestables.
 *
 * @param {Object} p
 * @param {string}  p.campusId       - Mandatory campus scope (from the S2S token).
 * @param {string}  p.type           - Portal source type ('portal-program' | 'portal-faq').
 * @param {Date}   [p.updatedAfter]  - Incremental reindex lower bound.
 * @param {Date}   [p.afterUpdatedAt] - Keyset cursor position (with afterId).
 * @param {string} [p.afterId]
 * @param {number}  p.limit          - Page size (already clamped ≤ 200 by the caller).
 * @param {string} [p.sourceId]      - Single-source fetch (event-driven ingestion).
 * @returns {Promise<{items: Object[], nextCursor: {updatedAt: Date, id: string}|null}>}
 */
const listAiIngestables = async ({ campusId, type, updatedAfter, afterUpdatedAt, afterId, limit, sourceId }) => {
  const mapper = INGESTABLE_MAPPERS[type];
  if (!mapper) throw new Error(`Unsupported portal ingestable type: ${type}`);

  // isPublished:true is mandatory — a draft/unpublished item must never leak
  // into the public vector index.
  const filter = { schoolCampus: campusId, isPublished: true };
  if (sourceId) filter._id = sourceId;
  if (updatedAfter) filter.updatedAt = { $gte: updatedAfter };
  if (afterUpdatedAt && afterId) {
    filter.$or = [
      { updatedAt: { $gt: afterUpdatedAt } },
      { updatedAt: afterUpdatedAt, _id: { $gt: afterId } },
    ];
  }

  // limit + 1 sentinel row: detects a next page without a count query.
  const docs = await repo.findIngestablePortalSources(type, filter, { limit: limit + 1 });
  const page = docs.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(mapper),
    nextCursor: docs.length > limit && last
      ? { updatedAt: last.updatedAt, id: String(last._id) }
      : null,
  };
};

/**
 * Answer-time re-authorization of PORTAL citations (§4.5). The portal corpus is
 * public marketing content (D6): a citation is authorized iff the source is
 * STILL published and belongs to the caller's campus (global roles: any campus).
 * There is NO per-user gating — the content carries no personal data.
 *
 * @param {Object} ctx - Verified S2S context { role, campusId }.
 * @param {Object} citationsByType - { 'portal-faq': string[], 'portal-program': string[] }.
 * @returns {Promise<Array<{sourceType: string, sourceId: string, label: string, url: string}>>}
 */
const authorizeAiCitations = async ({ role, campusId }, citationsByType) => {
  const globalRole = ['ADMIN', 'DIRECTOR'].includes(role);
  const allowed = [];

  for (const [sourceType, ids] of Object.entries(citationsByType || {})) {
    if (!INGESTABLE_MAPPERS[sourceType] || !Array.isArray(ids) || ids.length === 0) continue;

    // Revocation + campus cross-check baked into the query (isPublished + scope).
    const extraFilter = { isPublished: true };
    if (!globalRole) extraFilter.schoolCampus = campusId;

    const docs = await repo.findPortalCitationDocs(
      sourceType, [...new Set(ids.map(String))], extraFilter,
    );
    for (const doc of docs) {
      allowed.push({
        sourceType,
        sourceId: String(doc._id),
        label: citationLabel(sourceType, doc),
        url: '',
      });
    }
  }
  return allowed;
};

module.exports = {
  runCompetitionClosingJob,
  shutdownIngestionQueue,
  // AI (Phase 3) — public portal corpus ingestion + citation re-authorization
  listAiIngestables,
  authorizeAiCitations,
};
