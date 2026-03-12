'use strict';

/**
 * @file document.share.controller.js
 * @description Signed, expiring share link management.
 *
 * Security contract:
 *   1. token = crypto.randomBytes(32).toString('hex')  — 256-bit entropy, never stored
 *   2. tokenHash = SHA-256(token)                      — stored in DB
 *   3. token returned ONCE in creation response        — never retrievable again
 *   4. Verification: SHA-256(incoming) === DB.tokenHash
 *   5. Auto-revoke on maxDownloads reached or expiresAt exceeded
 *   6. Official documents auto-lock on first access
 *   7. Rate limit: 10 req/min/IP on public share endpoint (applied at router level)
 * Routes handled:
 *   POST   /api/documents/:id/share            — Create share link (auth required)
 *   GET    /api/documents/share/:token         — Public access via token (no auth, rate-limited)
 *   DELETE /api/documents/share/:shareId       — Revoke a share link (auth required)
 *   GET    /api/documents/:id/shares           — List active share links (auth required)
 */

const crypto = require('crypto');

const Document        = require('../../models/document-models/document.model');
const DocumentShare   = require('../../models/document-models/documentShare.model');
const { AUDIT_ACTION }    = require('../../models/document-models/documentAudit.model');
const documentService     = require('../../services/document-services/document.service');
const pdfService          = require('../../services/document-services/document.pdf.service');
const Campus              = require('../../models/campus.model');

const {
  sendSuccess, sendCreated, sendError, sendForbidden, sendNotFound, asyncHandler,
} = require('../../utils/responseHelpers');

// ── Create Share Link ─────────────────────────────────────────────────────────

/**
 * POST /api/documents/:id/share
 * Body: { expiresInHours?: number, maxDownloads?: number }
 *
 * Returns the plain token ONCE. It is not stored and cannot be retrieved again.
 * Only CAMPUS_MANAGER and above can create share links.
 *
 * Expiry rules:
 *   - Minimum: 1 hour
 *   - Default: SHARE_LINK_DEFAULT_EXPIRY_HOURS (env, default 48)
 *   - Maximum: SHARE_LINK_MAX_EXPIRY_DAYS * 24 (env, default 30 days)
 *
 * maxDownloads rules:
 *   - Minimum: 1
 *   - Default: 1
 *   - Maximum: SHARE_LINK_MAX_DOWNLOADS (env, default 50)
 */
const createShareLink = asyncHandler(async (req, res) => {
  if (!['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role)) {
    return sendForbidden(res, 'Creating share links requires CAMPUS_MANAGER or higher role');
  }

  const doc = await Document
    .findOne({
      _id:       req.params.id,
      campusId:  req.isGlobalRole ? undefined : req.campusId,
      deletedAt: null,
    })
    .select('_id campusId status isOfficial')
    .lean();

  if (!doc) return sendNotFound(res, 'Document');

  if (!['PUBLISHED', 'LOCKED'].includes(doc.status)) {
    return sendError(res, 409, 'Only PUBLISHED or LOCKED documents can be shared');
  }

  // Parse and enforce expiry bounds
  const defaultExpiryHours = parseInt(process.env.SHARE_LINK_DEFAULT_EXPIRY_HOURS || '48', 10);
  const maxExpiryDays      = parseInt(process.env.SHARE_LINK_MAX_EXPIRY_DAYS       || '30', 10);
  const maxDownloadsLimit  = parseInt(process.env.SHARE_LINK_MAX_DOWNLOADS         || '50', 10);

  const requestedHours = parseInt(req.body.expiresInHours ?? defaultExpiryHours, 10);
  const maxHours       = maxExpiryDays * 24;

  // Clamp between 1 hour (minimum) and the configured maximum
  const expiryHours = Math.min(Math.max(1, requestedHours), maxHours);

  const expiresAt    = new Date(Date.now() + expiryHours * 60 * 60 * 1000);
  const maxDownloads = Math.min(Math.max(1, parseInt(req.body.maxDownloads ?? '1', 10)), maxDownloadsLimit);

  // Generate secure token — plain token is NEVER persisted
  const plainToken = crypto.randomBytes(32).toString('hex');
  const tokenHash  = crypto.createHash('sha256').update(plainToken).digest('hex');

  const share = await DocumentShare.create({
    documentId: doc._id,
    campusId:   doc.campusId,
    tokenHash,
    expiresAt,
    maxDownloads,
    createdBy: {
      userId:    req.user.id,
      userModel: documentService.resolveUserModel(req.user.role),
    },
  });

  // Audit every share link creation with full traceability metadata
  await documentService.writeAudit(null, {
    documentId: doc._id,
    campusId:   doc.campusId,
    action:     AUDIT_ACTION.SHARE,
    req,
    metadata: {
      shareId:      share._id,
      expiresAt,
      expiryHours,
      maxDownloads,
    },
  });

  return sendCreated(res, 'Share link created', {
    shareId:      share._id,
    /** Plain token returned ONCE — not stored, not retrievable later */
    token:        plainToken,
    expiresAt,
    expiryHours,
    maxDownloads,
    shareUrl:     `${process.env.QR_VERIFICATION_BASE_URL || ''}/api/documents/share/${plainToken}`,
  });
});

// ── Public Share Access ───────────────────────────────────────────────────────

/**
 * GET /api/documents/share/:token
 * Public endpoint — no authentication required.
 * Rate limited at router level: 10 req/min/IP.
 *
 * Verifies token, streams the PDF, logs the access IP,
 * and auto-locks the document if isOfficial=true.
 */
const accessSharedDocument = asyncHandler(async (req, res) => {
  const { token } = req.params;

  if (!token || token.length !== 64) {
    return sendError(res, 400, 'Invalid share token format');
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const share = await DocumentShare
    .findOne({ tokenHash, revoked: false })
    .populate('documentId', 'title ref campusId status isOfficial pdfSnapshot currentVersion')
    .lean();

  if (!share) {
    return sendError(res, 404, 'Share link not found or has been revoked');
  }

  if (new Date() > share.expiresAt) {
    return sendError(res, 410, 'Share link has expired');
  }

  if (share.downloadCount >= share.maxDownloads) {
    return sendError(res, 410, 'Share link download limit reached');
  }

  const doc = share.documentId;
  if (!doc || doc.deletedAt) {
    return sendError(res, 404, 'Document no longer available');
  }

  // Log access IP and increment download counter
  await DocumentShare.findByIdAndUpdate(share._id, {
    $inc:  { downloadCount: 1 },
    $push: { accessedIps: req.ip },
  });

  // Auto-lock if official document and not already locked
  if (doc.isOfficial) {
    await documentService.autoLockIfOfficial(doc._id.toString());
  }

  // Generate or serve cached PDF
  const campus     = await Campus.findById(doc.campusId).select('campus_name').lean();
  const campusName = campus?.campus_name || '';

  const { buffer } = await pdfService.getOrGeneratePdf(doc._id.toString(), campusName);

  const safeTitle = doc.title.replace(/[^a-zA-Z0-9-_ ]/g, '').slice(0, 50);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.pdf"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');

  return res.send(buffer);
});

// ── Revoke Share Link ─────────────────────────────────────────────────────────

/**
 * DELETE /api/documents/share/:shareId
 * Revokes a share link immediately.
 * Only CAMPUS_MANAGER or higher of the same campus can revoke.
 */
const revokeShareLink = asyncHandler(async (req, res) => {
  if (!['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role)) {
    return sendForbidden(res, 'Revoking share links requires CAMPUS_MANAGER or higher role');
  }

  const filter = req.isGlobalRole
    ? { _id: req.params.shareId, revoked: false }
    : { _id: req.params.shareId, campusId: req.campusId, revoked: false };

  const share = await DocumentShare.findOneAndUpdate(
    filter,
    {
      revoked:   true,
      revokedAt: new Date(),
      revokedBy: req.user.id,
    },
    { new: true },
  );

  if (!share) return sendNotFound(res, 'Share link');

  return sendSuccess(res, 200, 'Share link revoked successfully');
});

// ── List Share Links for a Document ──────────────────────────────────────────

/**
 * GET /api/documents/:id/shares
 * Lists all active (non-expired, non-revoked) share links for a document.
 * Token values are NEVER returned — only metadata.
 */
const listShareLinks = asyncHandler(async (req, res) => {
  if (!['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role)) {
    return sendForbidden(res, 'Viewing share links requires CAMPUS_MANAGER or higher role');
  }

  const filter = {
    documentId: req.params.id,
    revoked:    false,
    expiresAt:  { $gt: new Date() },
  };
  if (!req.isGlobalRole) filter.campusId = req.campusId;

  const shares = await DocumentShare
    .find(filter)
    .select('-tokenHash')   // Never expose the hash in the API response
    .sort({ createdAt: -1 })
    .lean();

  return sendSuccess(res, 200, 'Share links retrieved', { shares });
});

module.exports = {
  createShareLink,
  accessSharedDocument,
  revokeShareLink,
  listShareLinks,
};