'use strict';

/**
 * @file document.service.js
 * @description Core business logic for the document module.
 *
 * Responsibilities:
 *   - CRUD orchestration (create, read, update, soft-delete, hard-delete)
 *   - Campus filter enforcement (Layer 2 isolation on all DB queries)
 *   - Retention policy auto-assignment at creation time
 *   - Audit event writing (delegates to writeAudit helper)
 *   - Auto-lock on official share
 *   - Storage cache invalidation after mutating operations
 *   - Slug generation (ref-suffixed → guaranteed unique in one pass, no while loop)
 *   - Document ref generation (DOC-{YEAR}-{CODE}-{nanoid8})
 */

const slugify  = require('slugify');
const { nanoid } = require('nanoid');

const repo = require('../document.repository');
// Lazy require: document is in the static closure of campus (via staff).
const getCampusName = (...args) => require('../../campus').service.getCampusName(...args);

const { invalidateStorageCache } = require('../middleware/document.campus.middleware');
const { validateContentBlocks }  = require('./document.validation.service');
const storageService             = require('./document.storage.service');

const {
  DOCUMENT_TYPE,
  DOCUMENT_STATUS,
  RETENTION_POLICY,
} = require('../models/document.model');

const { AUDIT_ACTION } = require('../models/document.audit.model');
const Document = require('../models/document.model');
const { deletedOnlyFilter } = require('../../../shared/utils/soft-delete');

/**
 * Deleted-only fragment for the trash view — derived from the model rather than hand-written,
 * because it is the exact complement of the `deletedAt: null` filter every other read carries
 * and the two must never drift apart.
 *
 * The trash view is what makes a soft-deleted document reachable at all: the danger zone
 * refuses a live record, and until now no listing returned anything else.
 */
const DELETED_ONLY = deletedOnlyFilter(Document);

/**
 * Fire-and-forget AI ingestion signal (Phase 3 design doc §6.3): notifies
 * ai-service that a document's publication state or content changed so the
 * vector index follows (index, reindex or prune — ai-service decides by
 * re-reading the source). Lazy require (ai lazily requires document back);
 * never awaited — a response never waits on the AI stack, and the signal is
 * a no-op when AI is disabled or the campus has not subscribed.
 */
const signalAiIngest = (documentId, campusId) => {
  require('../../ai').service.signalDocumentIngest({ campusId, sourceId: documentId });
};

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default retention policies by document type — regulatory obligation */
const RETENTION_DEFAULTS = Object.freeze({
  [DOCUMENT_TYPE.STUDENT_TRANSCRIPT]: { policy: RETENTION_POLICY.PERMANENT,  years: null },
  [DOCUMENT_TYPE.STUDENT_ID_CARD]:    { policy: RETENTION_POLICY.PERMANENT,  years: null },
  [DOCUMENT_TYPE.TEACHER_CONTRACT]:   { policy: RETENTION_POLICY.PERMANENT,  years: null },
  [DOCUMENT_TYPE.STUDENT_BADGE]:      { policy: RETENTION_POLICY.PERMANENT,  years: null },
  [DOCUMENT_TYPE.TEACHER_BADGE]:      { policy: RETENTION_POLICY.PERMANENT,  years: null },
  [DOCUMENT_TYPE.PARTNER_BADGE]:      { policy: RETENTION_POLICY.PERMANENT,  years: null },
  [DOCUMENT_TYPE.PARENT_BADGE]:       { policy: RETENTION_POLICY.PERMANENT,  years: null },
  [DOCUMENT_TYPE.CUSTOM]:             { policy: RETENTION_POLICY.PERMANENT,  years: null },
  [DOCUMENT_TYPE.TEACHER_PAYSLIP]:    { policy: RETENTION_POLICY.TEN_YEARS,  years: 10   },
  [DOCUMENT_TYPE.REPORT]:             { policy: RETENTION_POLICY.FIVE_YEARS, years: 5    },
  [DOCUMENT_TYPE.ADMINISTRATIVE]:     { policy: RETENTION_POLICY.FIVE_YEARS, years: 5    },
  [DOCUMENT_TYPE.CLASS_LIST]:         { policy: RETENTION_POLICY.FIVE_YEARS, years: 5    },
  [DOCUMENT_TYPE.COURSE_MATERIAL]:    { policy: RETENTION_POLICY.FIVE_YEARS, years: 5    },
  [DOCUMENT_TYPE.IMPORTED]:           { policy: RETENTION_POLICY.ONE_YEAR,   years: 1    },
});

/**
 * Debounce window for automatic version snapshots (in minutes).
 * If the last 'auto' snapshot was taken by the same user within this window,
 * a new snapshot is skipped to prevent version explosion from rapid edits.
 * Manual snapshots always bypass this guard.
 */
const SNAPSHOT_DEBOUNCE_MINUTES = parseInt(
  process.env.SNAPSHOT_DEBOUNCE_MINUTES || '15',
  10,
);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Maps a user role string to the Mongoose model discriminator name.
 *
 * @param {string} role
 * @returns {'Admin'|'Teacher'|'Campus'|'System'}
 */
const resolveUserModel = (role) => {
  const map = {
    ADMIN:          'Admin',
    DIRECTOR:       'Admin',
    CAMPUS_MANAGER: 'Campus',
    TEACHER:        'Teacher',
    SYSTEM:         'System',
  };
  return map[role] || 'Admin';
};

/**
 * Generates a unique document reference.
 * Format: DOC-{YEAR}-{CAMPUS_CODE}-{nanoid(8)}
 * The nanoid(8) suffix provides ~281 trillion combinations — immune to enumeration.
 *
 * @param {string} campusCode - Short campus identifier (uppercase)
 * @returns {{ ref: string, nanoSuffix: string }}
 */
const generateDocRef = (campusCode) => {
  const year       = new Date().getFullYear();
  const nanoSuffix = nanoid(8).toUpperCase();
  return {
    ref:        `DOC-${year}-${(campusCode || 'GEN').toUpperCase()}-${nanoSuffix}`,
    nanoSuffix,
  };
};

/**
 * Generates a URL slug for a document.
 *
 * Strategy (v1.3): append the same nanoid(8) suffix used in `ref`.
 * This guarantees uniqueness in a single operation — no while-loop retry needed,
 * even under high concurrency (e.g., bulk imports of 2000 documents).
 *
 * Example: "Annual Report 2025" + suffix "AB12CD34" → "annual-report-2025-ab12cd34"
 *
 * @param {string} title
 * @param {string} nanoSuffix - Same 8-char suffix used in the ref
 * @returns {string}
 */
const generateSlug = (title, nanoSuffix) => {
  const base = slugify(title, { lower: true, strict: true });
  return `${base}-${nanoSuffix.toLowerCase()}`;
};

/**
 * Computes retentionPolicy and retentionUntil based on document type and creation date.
 * ADMIN/DIRECTOR can override via explicit body fields.
 *
 * @param {string}  docType
 * @param {Date}    createdAt
 * @param {object}  overrides   - { retentionPolicy?, retentionUntil? } from request body
 * @param {boolean} canOverride - true only for ADMIN/DIRECTOR
 * @returns {{ retentionPolicy: string, retentionUntil: Date|null }}
 */
const computeRetention = (docType, createdAt, overrides = {}, canOverride = false) => {
  if (canOverride && overrides.retentionPolicy) {
    return {
      retentionPolicy: overrides.retentionPolicy,
      retentionUntil:  overrides.retentionUntil || null,
    };
  }

  const defaults = RETENTION_DEFAULTS[docType] || { policy: RETENTION_POLICY.PERMANENT, years: null };

  let retentionUntil = null;
  if (defaults.years) {
    retentionUntil = new Date(createdAt);
    retentionUntil.setFullYear(retentionUntil.getFullYear() + defaults.years);
  }

  return { retentionPolicy: defaults.policy, retentionUntil };
};

/**
 * Atomically writes a DocumentAudit record AND updates lastAuditEntry on the document.
 * Uses a Mongoose session when provided for transactional consistency.
 *
 * IMPORTANT: MongoDB transactions require a Replica Set configuration.
 * Standalone instances will throw on session.startTransaction().
 * Ensure MONGODB_URI points to a replica set in production.
 *
 * @param {mongoose.ClientSession|null} session
 * @param {object} params
 */
const writeAudit = async (session, {
  documentId,
  campusId,
  action,
  req,
  fieldChanged = null,
  oldValue     = null,
  newValue     = null,
  reason       = null,
  metadata     = null,
}) => {
  const performedBy = req?.user?.id   || null;
  const userModel   = req?.user?.role ? resolveUserModel(req.user.role) : 'System';
  const ipAddress   = req?.ip         || null;
  const userAgent   = req?.headers?.['user-agent'] || null;
  const performedAt = new Date();

  const entry = {
    documentId, campusId, action, performedBy, userModel,
    performedAt, fieldChanged, oldValue, newValue, reason,
    ipAddress, userAgent, metadata,
  };

  const createOptions = session ? { session } : {};
  await repo.createAudit([entry], createOptions);

  const updateOptions = session ? { session } : {};
  await repo.updateDocumentById(
    documentId,
    {
      lastAuditEntry: {
        action, performedBy, userModel, performedAt, ipAddress,
      },
    },
    updateOptions,
  );
};

// ── Service Methods ───────────────────────────────────────────────────────────

/**
 * Creates a new document record.
 * Validates content blocks, assigns retention, generates ref and slug,
 * and writes the CREATE audit entry.
 *
 * @param {import('express').Request} req
 * @param {object} dto - Validated body from createDocument.schema.js
 * @returns {Promise<Document>}
 */
const createDocument = async (req, dto) => {
  const session = await repo.startSession();
  session.startTransaction();

  try {
    // Validate content blocks (discriminated per-type validation)
    if (dto.body && dto.body.length > 0) {
      validateContentBlocks(dto.body);
    }

    // Fetch campus for ref generation and code extraction
    const campus = await getCampusName(req.campusId || dto.campusId);

    const campusCode = campus?.campus_name
      ? campus.campus_name.slice(0, 4).toUpperCase().replace(/\s/g, '')
      : 'GEN';

    // Generate ref and derive slug from the same nanoid suffix — no uniqueness loop needed
    const { ref, nanoSuffix } = generateDocRef(campusCode);
    const slug = generateSlug(dto.title, nanoSuffix);

    // Auto-assign retention policy
    const now = new Date();
    const canOverride = ['ADMIN', 'DIRECTOR'].includes(req.user.role);
    const { retentionPolicy, retentionUntil } = computeRetention(
      dto.type, now,
      { retentionPolicy: dto.retentionPolicy, retentionUntil: dto.retentionUntil },
      canOverride,
    );

    const docData = {
      ...dto,
      ref,
      slug,
      campusId: req.campusId || dto.campusId,
      createdBy: {
        userId:    req.user.id,
        userModel: resolveUserModel(req.user.role),
      },
      retentionPolicy,
      retentionUntil,
    };

    const [document] = await repo.createDocuments([docData], { session });

    await writeAudit(session, {
      documentId: document._id,
      campusId:   document.campusId,
      action:     AUDIT_ACTION.CREATE,
      req,
      metadata:   { type: document.type, ref: document.ref },
    });

    await session.commitTransaction();
    return document;

  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

/**
 * Lists documents with campus isolation, role-based filtering, and pagination.
 *
 * @param {import('express').Request} req
 * @param {object} queryParams
 * @returns {Promise<{ data: Document[], total: number, page: number, limit: number }>}
 */
const listDocuments = async (req, queryParams) => {
  const {
    type, category, status, tag,
    from, to,
    studentId, teacherId, courseId, classId,
    semester, academicYear,
    page = 1, limit = 20, sortBy = 'createdAt', sortDir = 'desc',
    deleted,
  } = queryParams;

  // Trash view: soft-deleted documents only. Restricted to global roles because they are the
  // only ones the danger-zone registry lets act on the result — and a soft-deleted document is
  // one an operator already decided nobody should see. The controller rejects the flag for any
  // other role rather than silently returning live documents instead.
  const deletionFragment = deleted === 'true' && req.isGlobalRole
    ? { ...DELETED_ONLY }
    : { deletedAt: null };

  // Start with campus-scoped base filter (Layer 2 isolation)
  const filter = req.isGlobalRole
    ? { ...deletionFragment }
    : { campusId: req.campusId, ...deletionFragment };

  if (type)     filter.type     = type;
  if (category) filter.category = category;
  if (status)   filter.status   = status;
  if (tag)      filter.tags     = { $in: Array.isArray(tag) ? tag : [tag] };

  // Date range filter on createdAt
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to)   filter.createdAt.$lte = new Date(to);
  }

  // Metadata filters (v1.2) — indexed lookups, prefer over full-text search
  if (studentId)    filter['metadata.studentId']    = studentId;
  if (teacherId)    filter['metadata.teacherId']    = teacherId;
  if (courseId)     filter['metadata.courseId']     = courseId;
  if (classId)      filter['metadata.classId']      = classId;
  if (semester)     filter['metadata.semester']     = semester;
  if (academicYear) filter['metadata.academicYear'] = academicYear;

  // TEACHER scope: only their own COURSE_MATERIAL documents
  if (req.user.role === 'TEACHER') {
    filter.type = DOCUMENT_TYPE.COURSE_MATERIAL;
    filter['createdBy.userId'] = req.user.id;
  }

  // STUDENT scope: only documents linked to this student
  if (req.user.role === 'STUDENT') {
    filter.linkedEntities = {
      $elemMatch: { entityType: 'Student', entityId: req.user.id },
    };
  }

  // PARENT scope: only documents linked to their children
  if (req.user.role === 'PARENT') {
    const parentOf = req.user.parentOf || [];
    filter.linkedEntities = {
      $elemMatch: { entityType: 'Student', entityId: { $in: parentOf } },
    };
  }

  const pageNum   = Math.max(1, parseInt(page, 10));
  const limitNum  = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const skip      = (pageNum - 1) * limitNum;
  const sortOrder = sortDir === 'asc' ? 1 : -1;

  const { data, total } = await repo.paginateDocuments(filter, {
    skip,
    limit: limitNum,
    sort:  { [sortBy]: sortOrder },
  });

  return { data, total, page: pageNum, limit: limitNum };
};

/**
 * Retrieves a single document with full body and populated linkedEntities.
 *
 * @param {string} documentId
 * @param {import('express').Request} req
 * @returns {Promise<Document|null>}
 */
const getDocumentById = async (documentId, req) => {
  const filter = req.isGlobalRole
    ? { _id: documentId, deletedAt: null }
    : { _id: documentId, campusId: req.campusId, deletedAt: null };

  return repo.findDocumentByIdPopulated(filter);
};

/**
 * Updates a document (partial update).
 * Validates updated content blocks, takes a version snapshot if the document is PUBLISHED,
 * and writes the UPDATE audit entry.
 *
 * Snapshot debounce (v1.3):
 * If the last 'auto' snapshot was taken by the same user within SNAPSHOT_DEBOUNCE_MINUTES,
 * no new snapshot is created. This prevents rapid successive edits from generating
 * dozens of version records in a short window.
 *
 * @param {string}  documentId
 * @param {object}  dto        - Partial validated body
 * @param {string}  reason     - Required when updating PUBLISHED or LOCKED documents
 * @param {import('express').Request} req
 * @returns {Promise<Document>}
 */
const updateDocument = async (documentId, dto, reason, req) => {
  const session = await repo.startSession();
  session.startTransaction();

  try {
    const filter = req.isGlobalRole
      ? { _id: documentId, deletedAt: null }
      : { _id: documentId, campusId: req.campusId, deletedAt: null };

    const current = await repo.findDocumentForWrite(filter, { session });
    if (!current) throw Object.assign(new Error('Document not found'), { statusCode: 404 });

    // Require reason for updates on sensitive status documents
    const requiresReason = [DOCUMENT_STATUS.PUBLISHED, DOCUMENT_STATUS.LOCKED].includes(current.status);
    if (requiresReason && (!reason || reason.trim().length < 10)) {
      throw Object.assign(
        new Error('A reason of at least 10 characters is required to modify a published or locked document'),
        { statusCode: 400 },
      );
    }

    // Validate updated content blocks before writing
    if (dto.body && dto.body.length > 0) {
      validateContentBlocks(dto.body);
    }

    // Take a version snapshot before any update to a PUBLISHED document — with debounce
    if (current.status === DOCUMENT_STATUS.PUBLISHED) {
      await takeVersionSnapshot(current, 'auto', req, session);
    }

    const updates = {
      ...dto,
      lastModifiedBy: {
        userId:    req.user.id,
        userModel: resolveUserModel(req.user.role),
      },
    };

    const updated = await repo.updateDocumentById(documentId, { $set: updates }, { new: true, session });

    await writeAudit(session, {
      documentId: updated._id,
      campusId:   updated.campusId,
      action:     AUDIT_ACTION.UPDATE,
      req,
      reason,
      metadata:   { fieldsChanged: Object.keys(dto) },
    });

    await session.commitTransaction();

    // Published content changed → keep the AI index in sync (§6.3).
    if ([DOCUMENT_STATUS.PUBLISHED, DOCUMENT_STATUS.LOCKED].includes(updated.status)) {
      signalAiIngest(updated._id, updated.campusId);
    }
    return updated;

  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

/**
 * Soft-deletes a document (sets deletedAt, deletedBy).
 * Only DRAFT documents can be soft-deleted by CAMPUS_MANAGER.
 * ADMIN/DIRECTOR can soft-delete any non-LOCKED document.
 *
 * @param {string} documentId
 * @param {string} reason     - Required (min 10 chars)
 * @param {import('express').Request} req
 */
const softDeleteDocument = async (documentId, reason, req) => {
  const session = await repo.startSession();
  session.startTransaction();

  try {
    const filter = req.isGlobalRole
      ? { _id: documentId, deletedAt: null }
      : { _id: documentId, campusId: req.campusId, deletedAt: null };

    const doc = await repo.findDocumentForWrite(filter, { session });
    if (!doc) throw Object.assign(new Error('Document not found'), { statusCode: 404 });

    if (!reason || reason.trim().length < 10) {
      throw Object.assign(
        new Error('A reason of at least 10 characters is required to delete a document'),
        { statusCode: 400 },
      );
    }

    // CAMPUS_MANAGER can only delete DRAFT documents
    if (req.user.role === 'CAMPUS_MANAGER' && doc.status !== DOCUMENT_STATUS.DRAFT) {
      throw Object.assign(
        new Error('Campus Manager can only delete DRAFT documents'),
        { statusCode: 403 },
      );
    }

    if (doc.status === DOCUMENT_STATUS.LOCKED) {
      throw Object.assign(
        new Error('Locked documents cannot be deleted. Unlock first.'),
        { statusCode: 403 },
      );
    }

    doc.deletedAt = new Date();
    doc.deletedBy = {
      userId:    req.user.id,
      userModel: resolveUserModel(req.user.role),
    };
    await repo.saveDocumentDoc(doc, { session });

    invalidateStorageCache(doc.campusId.toString());

    await writeAudit(session, {
      documentId: doc._id,
      campusId:   doc.campusId,
      action:     AUDIT_ACTION.DELETE,
      req,
      reason,
    });

    await session.commitTransaction();

    // Deleted source → ai-service prunes its chunks (§6.3 idempotence).
    signalAiIngest(doc._id, doc.campusId);

  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

/**
 * Every file on disk owned by a document and by nothing else.
 *
 * Deliberately excludes `branding.logo`: a logo is campus-level artwork shared by every
 * document that uses the same branding, so removing it with one document would blank the
 * others. Everything listed here is generated or uploaded for this document alone.
 *
 * @param {Object}   doc      - The document (Mongoose doc or lean).
 * @param {string[]} versionSnapshots - `pdfSnapshot` filenames of its versions.
 * @returns {Array<{ category: string, fileName: string }>}
 */
const collectOwnedFiles = (doc, versionSnapshots = []) => {
  const files = [];

  if (doc.importedFile?.fileName) files.push({ category: 'imported', fileName: doc.importedFile.fileName });
  if (doc.pdfSnapshot)            files.push({ category: 'pdf',      fileName: doc.pdfSnapshot });
  if (doc.qrCode?.fileName)       files.push({ category: 'qrcodes',  fileName: doc.qrCode.fileName });

  for (const fileName of versionSnapshots) {
    if (fileName) files.push({ category: 'pdf', fileName });
  }

  return files;
};

/**
 * Hard-deletes a document, all its versions, all its share links and every file it owns on
 * disk (ADMIN/DIRECTOR only). Audit records are NEVER deleted.
 *
 * The stored files are removed AFTER the commit and never throw: a leftover file is a cleanup
 * task, whereas rolling back a committed deletion is impossible. Leaving them behind is not an
 * option either — an imported PDF that survives its own permanent deletion is a readable copy
 * of a record the operator was told had been destroyed, on top of the storage leak that grows
 * with every deletion and is charged against the campus quota.
 *
 * @param {string} documentId
 * @param {import('express').Request} req
 * @returns {Promise<{ filesRemoved: string[] }>} Storage paths actually removed.
 */
const hardDeleteDocument = async (documentId, req) => {
  const session = await repo.startSession();
  session.startTransaction();

  let ownedFiles = [];
  let campusId;

  try {
    const doc = await repo.findDocumentByIdForWrite(documentId, { session });
    if (!doc) throw Object.assign(new Error('Document not found'), { statusCode: 404 });

    campusId = doc.campusId;

    // Read the version snapshots BEFORE their rows go: afterwards nothing maps the files on
    // disk back to this document.
    const versions = await repo.listVersionSnapshotFiles(documentId, { session });
    ownedFiles = collectOwnedFiles(doc, versions.map((v) => v.pdfSnapshot));

    await repo.deleteVersionsByDocument(documentId, { session });
    // Share links must go with the document: a surviving token resolves to a removed id.
    await repo.deleteSharesByDocument(documentId, { session });
    await repo.deleteDocumentById(documentId, { session });

    // Audit written WITHOUT the document (already removed) — no lastAuditEntry update needed
    await repo.createAudit([{
      documentId:  doc._id,
      campusId:    doc.campusId,
      action:      AUDIT_ACTION.DELETE,
      performedBy: req.user.id,
      userModel:   resolveUserModel(req.user.role),
      performedAt: new Date(),
      reason:      'Hard delete by administrator',
      ipAddress:   req.ip,
      userAgent:   req.headers?.['user-agent'],
    }], { session });

    await session.commitTransaction();

    // Deleted source → ai-service prunes its chunks (§6.3 idempotence).
    signalAiIngest(doc._id, doc.campusId);

  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }

  const filesRemoved = [];
  for (const { category, fileName } of ownedFiles) {
    try {
      const removed = await storageService.deleteFile(campusId, category, fileName);
      if (removed) filesRemoved.push(`${category}/${fileName}`);
    } catch (err) {
      console.error(`⚠️ document hard-delete: failed to remove ${category}/${fileName}:`, err.message);
    }
  }

  // Cache invalidated once the bytes are actually gone, so the recomputed usage reflects the
  // freed space rather than the pre-deletion footprint.
  invalidateStorageCache(campusId.toString());

  return { filesRemoved };
};

// ── Version Snapshot ──────────────────────────────────────────────────────────

/**
 * Takes a full snapshot of the current document state and saves it as a DocumentVersion.
 * Updates Document.versionHistory and increments currentVersion.
 *
 * Debounce guard (v1.3 — 'auto' snapshots only):
 * Checks the most recent version for this document. If it was created by the same
 * user within SNAPSHOT_DEBOUNCE_MINUTES, the snapshot is skipped.
 * This prevents bursts of rapid small edits from creating dozens of versions.
 * Manual snapshots always bypass this guard.
 *
 * @param {Document}                    doc
 * @param {'auto'|'manual'|'pre-publish'|'pre-archive'} snapshotReason
 * @param {import('express').Request}   req
 * @param {mongoose.ClientSession|null} session
 * @returns {Promise<DocumentVersion|null>} null if debounced
 */
const takeVersionSnapshot = async (doc, snapshotReason = 'auto', req, session = null) => {
  // Apply debounce only for automatic snapshots
  if (snapshotReason === 'auto' && req?.user?.id) {
    const debounceMs = SNAPSHOT_DEBOUNCE_MINUTES * 60 * 1000;
    const threshold  = new Date(Date.now() - debounceMs);

    const recentVersion = await repo.findRecentAutoSnapshot({
      documentId:     doc._id,
      snapshotReason: 'auto',
      'takenBy.userId': req.user.id,
      takenAt:        { $gte: threshold },
    }, { session });

    if (recentVersion) {
      // Debounce: skip creating a new version
      return null;
    }
  }

  const versionData = {
    documentId:     doc._id,
    campusId:       doc.campusId,
    version:        doc.currentVersion,
    title:          doc.title,
    body:           doc.body,
    status:         doc.status,
    branding:       doc.branding,
    pdfSnapshot:    doc.pdfSnapshot,
    snapshotReason,
    takenBy: {
      userId:    req?.user?.id   || null,
      userModel: req?.user?.role ? resolveUserModel(req.user.role) : 'System',
    },
    takenAt: new Date(),
  };

  const createOptions = session ? { session } : {};
  const [version] = await repo.createVersions([versionData], createOptions);

  const updateOptions = session ? { session } : {};
  await repo.updateDocumentById(
    doc._id,
    {
      $inc:  { currentVersion: 1 },
      $push: { versionHistory: version._id },
    },
    updateOptions,
  );

  return version;
};

// ── Auto-Lock ─────────────────────────────────────────────────────────────────

/**
 * Auto-locks an official document after its first external share access.
 * Called by document.share.controller.js when isOfficial=true.
 *
 * @param {string} documentId
 * @returns {Promise<void>}
 */
const autoLockIfOfficial = async (documentId) => {
  const doc = await repo.findDocumentByIdLean(documentId, 'status isOfficial campusId');
  if (!doc || !doc.isOfficial) return;
  if (doc.status === DOCUMENT_STATUS.LOCKED) return;

  const session = await repo.startSession();
  session.startTransaction();

  try {
    await repo.updateDocumentById(
      documentId,
      { status: DOCUMENT_STATUS.LOCKED, lockedAt: new Date() },
      { session },
    );

    await repo.createAudit([{
      documentId:  doc._id,
      campusId:    doc.campusId,
      action:      AUDIT_ACTION.LOCK,
      performedBy: null,
      userModel:   'System',
      performedAt: new Date(),
      reason:      'Auto-locked on official external share access',
    }], { session });

    await session.commitTransaction();
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

// ── Full-Text Search ──────────────────────────────────────────────────────────

/**
 * Performs document search, preferring indexed metadata filters over full-text.
 *
 * Strategy (v1.3):
 * - If metadata filters (studentId, teacherId, etc.) are present, they are applied
 *   via the compound indexes and $text is skipped.
 * - $text search is used ONLY when a `q` parameter is present AND no metadata
 *   filter already narrows the result set sufficiently.
 * - This matches the recommendation: metadata filters are fast indexed O(log n),
 *   full-text is a last resort.
 *
 * Phase 3: replace $text with MongoDB Atlas Search for fuzzy + synonym support.
 *
 * @param {import('express').Request} req
 * @param {object} params
 * @returns {Promise<{ data: Document[], total: number, page: number, limit: number }>}
 */
const searchDocuments = async (req, params) => {
  const { q, page = 1, limit = 20, ...filters } = params;

  const filter = req.isGlobalRole
    ? { deletedAt: null }
    : { campusId: req.campusId, deletedAt: null };

  // Apply metadata and classification filters first (indexed)
  if (filters.type)         filter.type                        = filters.type;
  if (filters.category)     filter.category                    = filters.category;
  if (filters.status)       filter.status                      = filters.status;
  if (filters.tag)          filter.tags                        = { $in: [filters.tag] };
  if (filters.studentId)    filter['metadata.studentId']       = filters.studentId;
  if (filters.teacherId)    filter['metadata.teacherId']       = filters.teacherId;
  if (filters.courseId)     filter['metadata.courseId']        = filters.courseId;
  if (filters.classId)      filter['metadata.classId']         = filters.classId;
  if (filters.semester)     filter['metadata.semester']        = filters.semester;
  if (filters.academicYear) filter['metadata.academicYear']    = filters.academicYear;

  // Full-text search applied last, as a supplementary filter
  const useTextSearch = q && q.trim();
  if (useTextSearch) {
    filter.$text = { $search: q.trim() };
  }

  const pageNum  = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const skip     = (pageNum - 1) * limitNum;

  const sortClause = useTextSearch
    ? { score: { $meta: 'textScore' } }
    : { createdAt: -1 };

  const { data, total } = await repo.searchDocuments(filter, {
    skip,
    limit:      limitNum,
    sort:       sortClause,
    projection: useTextSearch ? { score: { $meta: 'textScore' } } : {},
  });

  return { data, total, page: pageNum, limit: limitNum };
};

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  createDocument,
  listDocuments,
  getDocumentById,
  updateDocument,
  softDeleteDocument,
  hardDeleteDocument,
  takeVersionSnapshot,
  autoLockIfOfficial,
  searchDocuments,
  writeAudit,
  signalAiIngest,
  resolveUserModel,
  computeRetention,
  RETENTION_DEFAULTS,
  SNAPSHOT_DEBOUNCE_MINUTES,
};