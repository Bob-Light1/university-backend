'use strict';

/**
 * @file document.repository.js — data access layer of the document module.
 *
 * The ONLY file allowed to touch the 5 owned models:
 *   - Document         (document.model)
 *   - DocumentVersion  (document.version.model)
 *   - DocumentAudit    (document.audit.model)
 *   - DocumentTemplate (document.template.model)
 *   - DocumentShare    (document.share.model)
 *
 * Controllers (crud / workflow / template / audit / share / export), internal
 * service, inter-module facade service, retention cron, PDF service and the
 * two middlewares (campus / access) all go exclusively through it.
 *
 * Conventions (locked in by modules R1→R3):
 *   - Reads → plain objects (`.lean()`); query shapes (select,
 *     populate, sort) live HERE.
 *   - Hooked writes (retention/slug/ref, block validations) via
 *     load→mutate→save (findXxxForWrite + saveXxxDoc); otherwise named
 *     atomic operators ($inc downloadCount/usageCount, snapshot counters…).
 *   - Transactions: `startSession()` exposed; docs/writes accept
 *     `{ session }` and propagate it (`.session()` / `session` option).
 *   - Storage quota aggregate: the caller (middleware) provides the `$match`
 *     already cast to ObjectId. Campus isolation filters are built by
 *     the caller and passed through as-is.
 *
 * Accepted exceptions (stay outside the repo):
 *   - Domain constants (DOCUMENT_STATUS, DOCUMENT_TYPE, AUDIT_ACTION,
 *     RESTRICTED_DOCUMENT_TYPES, RETENTION_POLICY): imported directly by
 *     controllers/services — these are enums, not persistence access.
 *   - Business logic (role→userModel resolution, retention computation,
 *     snapshot debounce, ref/slug generation): stays in the services;
 *     it invokes the repo for persistence.
 */

const mongoose = require('mongoose');

const Document         = require('./models/document.model');
const DocumentVersion  = require('./models/document.version.model');
const DocumentAudit    = require('./models/document.audit.model');
const DocumentTemplate = require('./models/document.template.model');
const DocumentShare    = require('./models/document.share.model');

// Heavy fields omitted from list views (rich body + raw HTML).
const LIST_SELECT = '-body -rawHtml';

// ─────────────────────────────────────────────────────────────────────────────
// Transactions
// ─────────────────────────────────────────────────────────────────────────────

/** Opens a Mongoose session (CRUD / workflow / restore transactions). */
const startSession = () => mongoose.startSession();

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT — creation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates one (or several) document(s) — triggers the validation/save hooks.
 * Array form + `{ session }` for the create/duplicate transaction;
 * then returns the created array (the caller destructures `[doc]`).
 */
const createDocuments = (docs, opts) => Document.create(docs, opts);

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT — reads (controllers / internal service)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Paginated list + count (listDocuments). Filter and sort composed by
 * the caller; body/HTML omitted from the listing.
 */
const paginateDocuments = async (filter, { skip, limit, sort }) => {
  const [data, total] = await Promise.all([
    Document.find(filter).sort(sort).skip(skip).limit(limit).select(LIST_SELECT).lean(),
    Document.countDocuments(filter),
  ]);
  return { data, total };
};

/**
 * Paginated search (searchDocuments). `projection` carries the textScore when
 * `$text` is active; sort composed by the caller. Body/HTML omitted.
 */
const searchDocuments = async (filter, { skip, limit, sort, projection }) => {
  const [data, total] = await Promise.all([
    Document.find(filter, projection).sort(sort).skip(skip).limit(limit).select(LIST_SELECT).lean(),
    Document.countDocuments(filter),
  ]);
  return { data, total };
};

/** Detail of a non-deleted document + populated template (getDocumentById). */
const findDocumentByIdPopulated = (filter) =>
  Document.findOne(filter).populate('templateId', 'name type').lean();

/** Lean read by filter, optional select (duplication source / share). */
const findDocumentLean = (filter, select) => {
  const q = Document.findOne(filter);
  if (select) q.select(select);
  return q.lean();
};

/** Lean read by id, select provided (access middleware / export / autolock). */
const findDocumentByIdLean = (id, select) =>
  Document.findById(id).select(select).lean();

/** Lean read of a batch by filter, select provided (bulk export). */
const findDocumentsByFilterLean = (filter, select) =>
  Document.find(filter).select(select).lean();

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT — writes (hooked docs: retention/slug, status transitions)
// ─────────────────────────────────────────────────────────────────────────────

/** Non-lean doc by filter for write, session-aware (update / delete / workflow). */
const findDocumentForWrite = (filter, { session } = {}) =>
  Document.findOne(filter).session(session ?? null);

/** Non-lean doc by id for write, session-aware (lock / unlock / hard-delete). */
const findDocumentByIdForWrite = (id, { session } = {}) =>
  Document.findById(id).session(session ?? null);

/** Persists a document doc (triggers the save hooks). `opts`: { session }. */
const saveDocumentDoc = (doc, opts) => doc.save(opts);

/**
 * Generic update by id (findByIdAndUpdate). Used for operator-based writes
 * ($set on update, lastAuditEntry, snapshot counters $inc/$push,
 * workflow status, retention deletion). `opts`: { new?, session? }.
 */
const updateDocumentById = (id, update, opts) =>
  Document.findByIdAndUpdate(id, update, opts);

/** Atomic increment of the download counter (fire-and-forget). */
const incrementDownloadCount = (id) =>
  Document.findByIdAndUpdate(id, { $inc: { downloadCount: 1 } });

/** Writes the PDF snapshot file name (render cache). */
const setPdfSnapshot = (id, fileName) =>
  Document.findByIdAndUpdate(id, { pdfSnapshot: fileName });

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT — hard delete (ADMIN/DIRECTOR)
// ─────────────────────────────────────────────────────────────────────────────

/** Permanent deletion of a document, session-aware. */
const deleteDocumentById = (id, opts) => Document.findByIdAndDelete(id, opts);

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT — specialized reads (facade / cron / PDF)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Paginated list of a campus's PUBLISHED documents (staff facade, read-only):
 * internal fields omitted, recent-first sort. Returns { docs, total }.
 */
const paginatePublishedForCampus = async (filter, { skip, limit }) => {
  const [docs, total] = await Promise.all([
    Document.find(filter)
      .select('-__v -auditLog -versions')
      .sort({ createdAt: -1 })
      .skip(skip).limit(limit).lean(),
    Document.countDocuments(filter),
  ]);
  return { docs, total };
};

/** Batch of documents whose retention has expired (cron, by batch, lean). */
const findExpiredDocuments = (filter, { skip, limit }) =>
  Document.find(filter)
    .select('_id campusId ref retentionPolicy retentionUntil')
    .skip(skip).limit(limit).lean();

/** Full document for PDF rendering (body + branding + print config). */
const findDocumentForPdf = (id) =>
  Document.findById(id)
    .select('ref title body branding printConfig campusId currentVersion pdfSnapshot')
    .lean();

/** Minimal document to serve/regenerate the PDF cache (getOrGeneratePdf). */
const findDocumentForPdfCache = (id) =>
  Document.findById(id)
    .select('ref pdfSnapshot currentVersion campusId')
    .lean();

/**
 * Sum of imported file bytes within a scope (campus storage quota).
 * The caller provides the `$match` already cast to ObjectId. Returns the raw array.
 */
const aggregateImportedStorageBytes = (matchStage) =>
  Document.aggregate([
    { $match: matchStage },
    { $group: { _id: null, totalBytes: { $sum: '$importedFile.sizeBytes' } } },
  ]);

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT VERSION
// ─────────────────────────────────────────────────────────────────────────────

/** Latest 'auto' snapshot from the same user (debounce guard, lean, session-aware). */
const findRecentAutoSnapshot = (filter, { session } = {}) =>
  DocumentVersion.findOne(filter).select('_id takenAt').lean().session(session ?? null);

/** Creates one (or several) version snapshot(s). Array form + `{ session }`. */
const createVersions = (docs, opts) => DocumentVersion.create(docs, opts);

/** Paginated list of a document's versions (body omitted), version desc sort. */
const paginateVersions = async (filter, { skip, limit }) => {
  const [data, total] = await Promise.all([
    DocumentVersion.find(filter).sort({ version: -1 }).skip(skip).limit(limit).select('-body').lean(),
    DocumentVersion.countDocuments(filter),
  ]);
  return { data, total };
};

/** Version snapshot by filter (getVersion / restoreVersion), lean. */
const findVersionLean = (filter) => DocumentVersion.findOne(filter).lean();

/** Deletes all versions of a document (hard-delete), session-aware. */
const deleteVersionsByDocument = (documentId, opts) =>
  DocumentVersion.deleteMany({ documentId }, opts);

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT AUDIT (append-only: never deleted)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Writes one (or several) audit entr(y/ies). Array form + `{ session }` for
 * transactional writes; plain object form for the cron.
 */
const createAudit = (docs, opts) =>
  (opts === undefined ? DocumentAudit.create(docs) : DocumentAudit.create(docs, opts));

/** Paginated audit log (single document or whole campus), recent-first sort. */
const paginateAudits = async (filter, { skip, limit }) => {
  const [data, total] = await Promise.all([
    DocumentAudit.find(filter).sort({ performedAt: -1 }).skip(skip).limit(limit).lean(),
    DocumentAudit.countDocuments(filter),
  ]);
  return { data, total };
};

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT TEMPLATE
// ─────────────────────────────────────────────────────────────────────────────

/** Creates a template (triggers validation of layout blocks). */
const createTemplate = (payload) => DocumentTemplate.create(payload);

/** Visible active templates (global + campus), usage desc sort, lean. */
const listTemplates = (filter) =>
  DocumentTemplate.find(filter).sort({ usageCount: -1, createdAt: -1 }).lean();

/** Template by id, lean read (get / preview / generation). */
const findTemplateByIdLean = (id) => DocumentTemplate.findById(id).lean();

/** Template by id for write (update / deactivation). */
const findTemplateForWrite = (id) => DocumentTemplate.findById(id);

/** Persists a template doc (triggers the save hooks). */
const saveTemplateDoc = (doc) => doc.save();

/** Atomic increment of a template's usage counter (fire-and-forget). */
const incrementTemplateUsage = (id) =>
  DocumentTemplate.findByIdAndUpdate(id, { $inc: { usageCount: 1 } });

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT SHARE (expiring signed links)
// ─────────────────────────────────────────────────────────────────────────────

/** Creates a share link (tokenHash stored, never the plaintext token). */
const createShare = (payload) => DocumentShare.create(payload);

/**
 * Active share link by token hash + populated document (public access).
 * Document fields limited to what the public endpoint serves.
 */
const findShareByTokenHashPopulated = (tokenHash) =>
  DocumentShare.findOne({ tokenHash, revoked: false })
    .populate('documentId', 'title ref campusId status isOfficial pdfSnapshot currentVersion')
    .lean();

/** Records a shared access (counter + IP), atomic. */
const registerShareAccess = (id, ip) =>
  DocumentShare.findByIdAndUpdate(id, {
    $inc:  { downloadCount: 1 },
    $push: { accessedIps: ip },
  });

/** Revokes a scoped share link (revokeShareLink). Returns the updated doc. */
const revokeShare = (filter, payload) =>
  DocumentShare.findOneAndUpdate(filter, payload, { new: true });

/** Active share links of a document (hash excluded from the response), recent-first sort. */
const listShares = (filter) =>
  DocumentShare.find(filter).select('-tokenHash').sort({ createdAt: -1 }).lean();

module.exports = {
  // Transactions
  startSession,
  // Document — creation
  createDocuments,
  // Document — reads
  paginateDocuments,
  searchDocuments,
  findDocumentByIdPopulated,
  findDocumentLean,
  findDocumentByIdLean,
  findDocumentsByFilterLean,
  // Document — writes
  findDocumentForWrite,
  findDocumentByIdForWrite,
  saveDocumentDoc,
  updateDocumentById,
  incrementDownloadCount,
  setPdfSnapshot,
  // Document — hard delete
  deleteDocumentById,
  // Document — specialized reads
  paginatePublishedForCampus,
  findExpiredDocuments,
  findDocumentForPdf,
  findDocumentForPdfCache,
  aggregateImportedStorageBytes,
  // DocumentVersion
  findRecentAutoSnapshot,
  createVersions,
  paginateVersions,
  findVersionLean,
  deleteVersionsByDocument,
  // DocumentAudit
  createAudit,
  paginateAudits,
  // DocumentTemplate
  createTemplate,
  listTemplates,
  findTemplateByIdLean,
  findTemplateForWrite,
  saveTemplateDoc,
  incrementTemplateUsage,
  // DocumentShare
  createShare,
  findShareByTokenHashPopulated,
  registerShareAccess,
  revokeShare,
  listShares,
};
