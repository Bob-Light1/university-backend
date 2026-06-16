'use strict';

/**
 * @file document.repository.js — couche d'accès aux données du module document.
 *
 * SEUL fichier autorisé à toucher les 5 models possédés :
 *   - Document         (document.model)
 *   - DocumentVersion  (document.version.model)
 *   - DocumentAudit    (document.audit.model)
 *   - DocumentTemplate (document.template.model)
 *   - DocumentShare    (document.share.model)
 *
 * Controllers (crud / workflow / template / audit / share / export), service
 * interne, service façade inter-modules, cron de rétention, service PDF et les
 * deux middlewares (campus / access) passent exclusivement par lui.
 *
 * Conventions (figées par les modules R1→R3) :
 *   - Lectures → objets simples (`.lean()`) ; les formes de requête (select,
 *     populate, sort) vivent ICI.
 *   - Écritures à hook (retention/slug/ref, validations de blocs) via
 *     load→mutate→save (findXxxForWrite + saveXxxDoc) ; sinon opérateurs
 *     atomiques nommés ($inc downloadCount/usageCount, snapshot counters…).
 *   - Transactions : `startSession()` exposé ; les docs/écritures acceptent
 *     `{ session }` et le propagent (`.session()` / option `session`).
 *   - Agrégat de quota stockage : l'appelant (middleware) fournit le `$match`
 *     déjà casté en ObjectId. Les filtres d'isolation campus sont construits par
 *     l'appelant et passés tels quels.
 *
 * Exceptions assumées (restent hors repo) :
 *   - Constantes de domaine (DOCUMENT_STATUS, DOCUMENT_TYPE, AUDIT_ACTION,
 *     RESTRICTED_DOCUMENT_TYPES, RETENTION_POLICY) : importées directement par
 *     les controllers/services — ce sont des enums, pas un accès persistance.
 *   - Logique métier (résolution de rôle→userModel, calcul de rétention,
 *     débounce de snapshot, génération ref/slug) : reste dans les services ;
 *     elle invoque le repo pour la persistance.
 */

const mongoose = require('mongoose');

const Document         = require('./models/document.model');
const DocumentVersion  = require('./models/document.version.model');
const DocumentAudit    = require('./models/document.audit.model');
const DocumentTemplate = require('./models/document.template.model');
const DocumentShare    = require('./models/document.share.model');

// Champs lourds omis des vues liste (corps riche + HTML brut).
const LIST_SELECT = '-body -rawHtml';

// ─────────────────────────────────────────────────────────────────────────────
// Transactions
// ─────────────────────────────────────────────────────────────────────────────

/** Ouvre une session Mongoose (transactions CRUD / workflow / restauration). */
const startSession = () => mongoose.startSession();

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT — création
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Crée un (ou des) document(s) — déclenche les hooks de validation/save.
 * Forme tableau + `{ session }` pour la transaction de création/duplication ;
 * renvoie alors le tableau créé (l'appelant déstructure `[doc]`).
 */
const createDocuments = (docs, opts) => Document.create(docs, opts);

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT — lectures (controllers / service interne)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Liste paginée + compteur (listDocuments). Filtre et tri composés par
 * l'appelant ; corps/HTML omis du listing.
 */
const paginateDocuments = async (filter, { skip, limit, sort }) => {
  const [data, total] = await Promise.all([
    Document.find(filter).sort(sort).skip(skip).limit(limit).select(LIST_SELECT).lean(),
    Document.countDocuments(filter),
  ]);
  return { data, total };
};

/**
 * Recherche paginée (searchDocuments). `projection` porte le textScore quand le
 * `$text` est actif ; tri composé par l'appelant. Corps/HTML omis.
 */
const searchDocuments = async (filter, { skip, limit, sort, projection }) => {
  const [data, total] = await Promise.all([
    Document.find(filter, projection).sort(sort).skip(skip).limit(limit).select(LIST_SELECT).lean(),
    Document.countDocuments(filter),
  ]);
  return { data, total };
};

/** Détail d'un document non supprimé + template peuplé (getDocumentById). */
const findDocumentByIdPopulated = (filter) =>
  Document.findOne(filter).populate('templateId', 'name type').lean();

/** Lecture lean par filtre, select optionnel (duplication source / partage). */
const findDocumentLean = (filter, select) => {
  const q = Document.findOne(filter);
  if (select) q.select(select);
  return q.lean();
};

/** Lecture lean par id, select fourni (access middleware / export / autolock). */
const findDocumentByIdLean = (id, select) =>
  Document.findById(id).select(select).lean();

/** Lecture lean d'un lot par filtre, select fourni (bulk export). */
const findDocumentsByFilterLean = (filter, select) =>
  Document.find(filter).select(select).lean();

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT — écritures (docs à hook : retention/slug, transitions de statut)
// ─────────────────────────────────────────────────────────────────────────────

/** Doc non-lean par filtre pour écriture, session-aware (update / delete / workflow). */
const findDocumentForWrite = (filter, { session } = {}) =>
  Document.findOne(filter).session(session ?? null);

/** Doc non-lean par id pour écriture, session-aware (lock / unlock / hard-delete). */
const findDocumentByIdForWrite = (id, { session } = {}) =>
  Document.findById(id).session(session ?? null);

/** Persiste un doc document (déclenche les hooks de save). `opts` : { session }. */
const saveDocumentDoc = (doc, opts) => doc.save(opts);

/**
 * MAJ générique par id (findByIdAndUpdate). Utilisé pour les écritures à
 * opérateurs ($set d'update, lastAuditEntry, snapshot counters $inc/$push,
 * statut workflow, suppression rétention). `opts` : { new?, session? }.
 */
const updateDocumentById = (id, update, opts) =>
  Document.findByIdAndUpdate(id, update, opts);

/** Incrément atomique du compteur de téléchargements (fire-and-forget). */
const incrementDownloadCount = (id) =>
  Document.findByIdAndUpdate(id, { $inc: { downloadCount: 1 } });

/** Écrit le nom de fichier du snapshot PDF (cache de rendu). */
const setPdfSnapshot = (id, fileName) =>
  Document.findByIdAndUpdate(id, { pdfSnapshot: fileName });

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT — suppression dure (ADMIN/DIRECTOR)
// ─────────────────────────────────────────────────────────────────────────────

/** Suppression définitive d'un document, session-aware. */
const deleteDocumentById = (id, opts) => Document.findByIdAndDelete(id, opts);

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT — lectures spécialisées (façade / cron / PDF)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Liste paginée des documents PUBLISHED d'un campus (façade staff, lecture
 * seule) : champs internes omis, tri récent. Renvoie { docs, total }.
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

/** Lot de documents dont la rétention a expiré (cron, par batch, lean). */
const findExpiredDocuments = (filter, { skip, limit }) =>
  Document.find(filter)
    .select('_id campusId ref retentionPolicy retentionUntil')
    .skip(skip).limit(limit).lean();

/** Document complet pour rendu PDF (corps + branding + config impression). */
const findDocumentForPdf = (id) =>
  Document.findById(id)
    .select('ref title body branding printConfig campusId currentVersion pdfSnapshot')
    .lean();

/** Document minimal pour servir/régénérer le cache PDF (getOrGeneratePdf). */
const findDocumentForPdfCache = (id) =>
  Document.findById(id)
    .select('ref pdfSnapshot currentVersion campusId')
    .lean();

/**
 * Somme des octets des fichiers importés d'un périmètre (quota stockage campus).
 * L'appelant fournit le `$match` déjà casté en ObjectId. Renvoie le tableau brut.
 */
const aggregateImportedStorageBytes = (matchStage) =>
  Document.aggregate([
    { $match: matchStage },
    { $group: { _id: null, totalBytes: { $sum: '$importedFile.sizeBytes' } } },
  ]);

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT VERSION
// ─────────────────────────────────────────────────────────────────────────────

/** Dernier snapshot 'auto' du même utilisateur (garde de débounce, lean, session-aware). */
const findRecentAutoSnapshot = (filter, { session } = {}) =>
  DocumentVersion.findOne(filter).select('_id takenAt').lean().session(session ?? null);

/** Crée un (ou des) snapshot(s) de version. Forme tableau + `{ session }`. */
const createVersions = (docs, opts) => DocumentVersion.create(docs, opts);

/** Liste paginée des versions d'un document (corps omis), tri version desc. */
const paginateVersions = async (filter, { skip, limit }) => {
  const [data, total] = await Promise.all([
    DocumentVersion.find(filter).sort({ version: -1 }).skip(skip).limit(limit).select('-body').lean(),
    DocumentVersion.countDocuments(filter),
  ]);
  return { data, total };
};

/** Snapshot de version par filtre (getVersion / restoreVersion), lean. */
const findVersionLean = (filter) => DocumentVersion.findOne(filter).lean();

/** Supprime toutes les versions d'un document (hard-delete), session-aware. */
const deleteVersionsByDocument = (documentId, opts) =>
  DocumentVersion.deleteMany({ documentId }, opts);

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT AUDIT (append-only : jamais supprimé)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Écrit une (ou des) entrée(s) d'audit. Forme tableau + `{ session }` pour les
 * écritures transactionnelles ; forme objet simple pour le cron.
 */
const createAudit = (docs, opts) =>
  (opts === undefined ? DocumentAudit.create(docs) : DocumentAudit.create(docs, opts));

/** Journal d'audit paginé (document seul ou campus entier), tri récent. */
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

/** Crée un template (déclenche la validation des blocs de layout). */
const createTemplate = (payload) => DocumentTemplate.create(payload);

/** Templates actifs visibles (globaux + campus), tri usage décroissant, lean. */
const listTemplates = (filter) =>
  DocumentTemplate.find(filter).sort({ usageCount: -1, createdAt: -1 }).lean();

/** Template par id, lecture lean (get / preview / génération). */
const findTemplateByIdLean = (id) => DocumentTemplate.findById(id).lean();

/** Template par id pour écriture (update / désactivation). */
const findTemplateForWrite = (id) => DocumentTemplate.findById(id);

/** Persiste un doc template (déclenche les hooks de save). */
const saveTemplateDoc = (doc) => doc.save();

/** Incrément atomique du compteur d'utilisation d'un template (fire-and-forget). */
const incrementTemplateUsage = (id) =>
  DocumentTemplate.findByIdAndUpdate(id, { $inc: { usageCount: 1 } });

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT SHARE (liens signés expirants)
// ─────────────────────────────────────────────────────────────────────────────

/** Crée un lien de partage (tokenHash stocké, jamais le token en clair). */
const createShare = (payload) => DocumentShare.create(payload);

/**
 * Lien de partage actif par hash de token + document peuplé (accès public).
 * Champs du document limités à ce que sert l'endpoint public.
 */
const findShareByTokenHashPopulated = (tokenHash) =>
  DocumentShare.findOne({ tokenHash, revoked: false })
    .populate('documentId', 'title ref campusId status isOfficial pdfSnapshot currentVersion')
    .lean();

/** Enregistre un accès partagé (compteur + IP), atomique. */
const registerShareAccess = (id, ip) =>
  DocumentShare.findByIdAndUpdate(id, {
    $inc:  { downloadCount: 1 },
    $push: { accessedIps: ip },
  });

/** Révoque un lien de partage scopé (revokeShareLink). Renvoie le doc à jour. */
const revokeShare = (filter, payload) =>
  DocumentShare.findOneAndUpdate(filter, payload, { new: true });

/** Liens de partage actifs d'un document (hash exclu de la réponse), tri récent. */
const listShares = (filter) =>
  DocumentShare.find(filter).select('-tokenHash').sort({ createdAt: -1 }).lean();

module.exports = {
  // Transactions
  startSession,
  // Document — création
  createDocuments,
  // Document — lectures
  paginateDocuments,
  searchDocuments,
  findDocumentByIdPopulated,
  findDocumentLean,
  findDocumentByIdLean,
  findDocumentsByFilterLean,
  // Document — écritures
  findDocumentForWrite,
  findDocumentByIdForWrite,
  saveDocumentDoc,
  updateDocumentById,
  incrementDownloadCount,
  setPdfSnapshot,
  // Document — suppression dure
  deleteDocumentById,
  // Document — lectures spécialisées
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
