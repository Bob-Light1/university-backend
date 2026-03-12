'use strict';

/**
 * @file document.campus.middleware.js
 * @description Layer 1 campus isolation for the document module.
 *
 * Responsibilities:
 *   1. Extract campusId from JWT payload and attach to req.campusId.
 *   2. Grant ADMIN/DIRECTOR global access (req.campusId = null).
 *   3. Block all users without a valid campus assignment.
 *   4. Enforce campus storage quota on upload/create operations.
 *
 * This is Layer 1 of 3 independent campus isolation layers:
 *   Layer 1 → this middleware (campusId extraction + quota)
 *   Layer 2 → document.service.js (campus filter on all DB queries)
 *   Layer 3 → document.access.middleware.js (doc.campusId === req.campusId cross-check)
 */

const mongoose = require('mongoose');
const Campus   = require('../../models/campus.model');
const Document = require('../../models/document-models/document.model');

const { sendError, sendForbidden } = require('../../utils/responseHelpers');

/** Roles with cross-campus (global) access */
const GLOBAL_ROLES = ['ADMIN', 'DIRECTOR'];

/** In-memory LRU-style cache for storage usage (TTL: 5 minutes per campus) */
const storageCache         = new Map();
const STORAGE_CACHE_TTL_MS = 5 * 60 * 1000;

// ── Helper: compute campus storage usage ──────────────────────────────────────

/**
 * Aggregates total storage used by a campus across all non-deleted documents.
 * Results are cached for STORAGE_CACHE_TTL_MS to prevent repeated aggregation calls.
 *
 * @param {string} campusId
 * @returns {Promise<number>} Total usage in MB
 */
const computeCampusStorageUsageMB = async (campusId) => {
  const cacheKey = campusId.toString();
  const cached   = storageCache.get(cacheKey);

  if (cached && (Date.now() - cached.timestamp) < STORAGE_CACHE_TTL_MS) {
    return cached.valueMB;
  }

  const result = await Document.aggregate([
    {
      $match: {
        // Fix: use `new` — direct constructor call is deprecated in Mongoose 7+
        campusId:                new mongoose.Types.ObjectId(campusId),
        deletedAt:               null,
        'importedFile.sizeBytes': { $exists: true, $ne: null },
      },
    },
    {
      $group: {
        _id:        null,
        totalBytes: { $sum: '$importedFile.sizeBytes' },
      },
    },
  ]);

  const totalBytes = result.length > 0 ? result[0].totalBytes : 0;
  const totalMB    = totalBytes / (1024 * 1024);

  storageCache.set(cacheKey, { valueMB: totalMB, timestamp: Date.now() });

  return totalMB;
};

/**
 * Invalidates the storage cache for a campus.
 * Must be called after any successful document upload, import, or delete.
 *
 * @param {string} campusId
 */
const invalidateStorageCache = (campusId) => {
  storageCache.delete(campusId.toString());
};

// ── Middleware: campus access ─────────────────────────────────────────────────

/**
 * Extracts campusId from the authenticated user's JWT payload and attaches
 * it to req.campusId. ADMIN and DIRECTOR receive null (global access).
 *
 * Must be placed AFTER authenticate middleware.
 *
 * @example
 *   router.get('/', authenticate, enforceCampusAccess, listDocuments);
 */
const enforceCampusAccess = (req, res, next) => {
  try {
    const { role, campusId } = req.user;

    if (GLOBAL_ROLES.includes(role)) {
      req.campusId     = null;
      req.isGlobalRole = true;
      return next();
    }

    if (!campusId) {
      return sendForbidden(res, 'No campus assigned to your account. Access denied.');
    }

    req.campusId     = campusId;
    req.isGlobalRole = false;

    next();
  } catch (err) {
    return sendError(res, 500, 'Campus access validation failed', err);
  }
};

// ── Middleware: storage quota ─────────────────────────────────────────────────

/**
 * Checks whether the campus has sufficient storage quota before allowing
 * document creation or file import. Skips non-POST requests automatically.
 *
 * Must be placed AFTER enforceCampusAccess.
 *
 * @example
 *   router.post('/', authenticate, enforceCampusAccess, enforceCampusStorageQuota, createDocument);
 */
const enforceCampusStorageQuota = async (req, res, next) => {
  try {
    if (req.method !== 'POST') return next();
    if (req.isGlobalRole)      return next();

    const campus = await Campus
      .findById(req.campusId)
      .select('features campus_name')
      .lean();

    if (!campus) {
      return sendError(res, 404, 'Campus not found');
    }

    const maxMB = (campus.features?.maxDocumentStorageMB
               ?? parseInt(process.env.DOC_DEFAULT_STORAGE_QUOTA_MB, 10))
               || 5120;

    const usedMB = await computeCampusStorageUsageMB(req.campusId);

    if (usedMB >= maxMB) {
      return res.status(413).json({
        success: false,
        message: `Campus storage quota exceeded (${maxMB} MB used: ${Math.round(usedMB)} MB). Please contact your administrator.`,
        data:    { usedMB: Math.round(usedMB), maxMB },
      });
    }

    req.storageInfo = { usedMB: Math.round(usedMB * 100) / 100, maxMB };

    next();
  } catch (err) {
    return sendError(res, 500, 'Storage quota check failed', err);
  }
};

// ── Helper: build base campus filter ─────────────────────────────────────────

/**
 * Returns a MongoDB filter object scoped to the request's campus.
 * Applied in ALL document DB queries to enforce Layer 2 isolation.
 *
 * Global roles receive an empty filter (all campuses).
 * All other roles receive { campusId: req.campusId, deletedAt: null }.
 *
 * @param {import('express').Request} req
 * @returns {object} MongoDB filter
 */
const buildCampusFilter = (req) => {
  if (req.isGlobalRole) {
    return { deletedAt: null };
  }
  return {
    campusId:  req.campusId,
    deletedAt: null,
  };
};

module.exports = {
  enforceCampusAccess,
  enforceCampusStorageQuota,
  buildCampusFilter,
  invalidateStorageCache,
  computeCampusStorageUsageMB,
};