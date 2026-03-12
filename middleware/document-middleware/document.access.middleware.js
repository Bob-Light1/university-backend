'use strict';

/**
 * @file document.access.middleware.js
 * @description Per-document access control and document-type guard.
 *
 * Implements two independent security layers applied on all document-specific routes:
 *
 *   Layer 3 (campus cross-check):
 *     After fetching the document by ID, verify doc.campusId === req.campusId.
 *     Prevents cross-campus access by forged IDs, even if Layer 1 is bypassed.
 *
 *   Layer B (document-type guard):
 *     Independently enforces type-based restrictions.
 *     A TEACHER who passes role checks (Layer A) is still blocked here if the
 *     requested type is in RESTRICTED_DOCUMENT_TYPES.
 *
 * Role-specific scope enforcement (TEACHER, STUDENT, PARENT) is also applied here.
 */

const mongoose = require('mongoose');
const Document = require('../../models/document-models/document.model');
const Course   = require('../../models/course.model');
const { sendError, sendForbidden, sendNotFound } = require('../../utils/responseHelpers');
const { RESTRICTED_DOCUMENT_TYPES, DOCUMENT_STATUS } = require('../../models/document-models/document.model');

/** Roles with global (cross-campus) access */
const GLOBAL_ROLES = ['ADMIN', 'DIRECTOR'];

// ── Layer 3: Per-document campus cross-check ──────────────────────────────────

/**
 * Fetches the document by req.params.id, verifies it belongs to the user's campus,
 * and attaches it to req.document for downstream controllers.
 *
 * Must be placed AFTER enforceCampusAccess.
 *
 * @example
 *   router.patch('/:id', authenticate, enforceCampusAccess, loadAndVerifyDocument, updateDocument);
 */
const loadAndVerifyDocument = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return sendNotFound(res, 'Document');
    }

    // Select only fields needed for access control — avoid loading full body in middleware
    const doc = await Document
      .findById(id)
      .select('campusId type status isOfficial createdBy linkedEntities deletedAt')
      .lean();

    if (!doc || doc.deletedAt) {
      return sendNotFound(res, 'Document');
    }

    // Campus cross-check — Layer 3
    if (!GLOBAL_ROLES.includes(req.user.role)) {
      if (doc.campusId.toString() !== req.campusId?.toString()) {
        return sendForbidden(res, 'Access denied — document belongs to a different campus');
      }
    }

    req.document = doc;
    next();
  } catch (err) {
    return sendError(res, 500, 'Document access verification failed', err);
  }
};

// ── Layer B: Document-type guard ──────────────────────────────────────────────

/**
 * Independently enforces type-based restrictions.
 * Applied on create and update routes where req.body.type may be set.
 *
 * TEACHER is strictly limited to COURSE_MATERIAL.
 * This check is independent of the role check — both must pass.
 *
 * For updates, the type is read from the loaded document (req.document)
 * if not explicitly present in the body.
 *
 * @example
 *   router.post('/', authenticate, enforceCampusAccess, enforceDocumentTypeAccess, createDocument);
 */
const enforceDocumentTypeAccess = (req, res, next) => {
  const { role } = req.user;
  const docType  = req.body.type || req.document?.type;

  if (!docType) return next(); // No type context — let the controller validate

  if (role === 'TEACHER') {
    // TEACHER is only allowed to interact with COURSE_MATERIAL
    if (docType !== 'COURSE_MATERIAL') {
      return sendForbidden(
        res,
        `Role TEACHER cannot interact with document type: ${docType}. Only COURSE_MATERIAL is allowed.`,
      );
    }
  }

  if (role === 'STUDENT' || role === 'PARENT') {
    // Students and parents have read-only access — no type guard needed for writes
    // Their scope is enforced by enforceStudentAccess / enforceParentAccess below
    return next();
  }

  next();
};

// ── TEACHER scope enforcement ─────────────────────────────────────────────────

/**
 * Ensures a TEACHER can only access COURSE_MATERIAL documents where they are
 * the assigned teacher of the linked course.
 *
 * Must be called AFTER loadAndVerifyDocument (requires req.document).
 * Only applies when req.user.role === 'TEACHER'.
 *
 * @example
 *   router.get('/:id', authenticate, enforceCampusAccess, loadAndVerifyDocument, enforceTeacherScope, getDocument);
 */
const enforceTeacherScope = async (req, res, next) => {
  if (req.user.role !== 'TEACHER') return next();

  const doc = req.document;

  // TEACHER can only access COURSE_MATERIAL
  if (doc.type !== 'COURSE_MATERIAL') {
    return sendForbidden(res, 'Teachers may only access COURSE_MATERIAL documents');
  }

  // Verify the teacher is assigned to the linked course
  const courseLinks = (doc.linkedEntities || []).filter((e) => e.entityType === 'Course');

  if (courseLinks.length === 0) {
    return sendForbidden(res, 'This course material is not linked to any course');
  }

  // Verify at least one linked course belongs to this teacher
  const courseIds = courseLinks.map((e) => e.entityId);
  const ownedCourse = await Course.findOne({
    _id:     { $in: courseIds },
    teacher: req.user.id,
  }).select('_id').lean();

  if (!ownedCourse) {
    return sendForbidden(res, 'You are not assigned to the course linked to this document');
  }

  next();
};

// ── Student access enforcement ────────────────────────────────────────────────

/**
 * Ensures a STUDENT can only access documents where their own ID appears
 * in linkedEntities (entity type: Student).
 *
 * Must be called AFTER loadAndVerifyDocument.
 *
 * @example
 *   router.get('/:id', authenticate, enforceCampusAccess, loadAndVerifyDocument, enforceStudentScope, getDocument);
 */
const enforceStudentScope = (req, res, next) => {
  if (req.user.role !== 'STUDENT') return next();

  const doc = req.document;
  const studentLinks = (doc.linkedEntities || []).filter((e) => e.entityType === 'Student');

  const hasAccess = studentLinks.some(
    (e) => e.entityId.toString() === req.user.id,
  );

  if (!hasAccess) {
    return sendForbidden(res, 'You do not have access to this document');
  }

  next();
};

// ── Parent access enforcement ─────────────────────────────────────────────────

/**
 * Ensures a PARENT can only access documents linked to their registered children.
 * Children IDs are stored in req.user.parentOf (array of studentIds in JWT payload).
 *
 * Must be called AFTER loadAndVerifyDocument.
 */
const enforceParentScope = (req, res, next) => {
  if (req.user.role !== 'PARENT') return next();

  const parentOf = req.user.parentOf || [];

  if (parentOf.length === 0) {
    return sendForbidden(res, 'No children registered to your account');
  }

  const doc = req.document;
  const studentLinks = (doc.linkedEntities || []).filter((e) => e.entityType === 'Student');

  const hasAccess = studentLinks.some(
    (e) => parentOf.map(String).includes(e.entityId.toString()),
  );

  if (!hasAccess) {
    return sendForbidden(res, 'You do not have access to this document');
  }

  next();
};

// ── Status guard ──────────────────────────────────────────────────────────────

/**
 * Prevents modification of a LOCKED document by non-privileged roles.
 * LOCKED documents require ADMIN or DIRECTOR to unlock first.
 *
 * Must be called AFTER loadAndVerifyDocument.
 *
 * @example
 *   router.patch('/:id', authenticate, enforceCampusAccess, loadAndVerifyDocument, enforceLockGuard, updateDocument);
 */
const enforceLockGuard = (req, res, next) => {
  if (!req.document) return next();

  const isLocked    = req.document.status === DOCUMENT_STATUS.LOCKED;
  const canUnlock   = GLOBAL_ROLES.includes(req.user.role);

  if (isLocked && !canUnlock) {
    return sendForbidden(
      res,
      'This document is locked. Only ADMIN or DIRECTOR can modify locked documents.',
    );
  }

  next();
};

// ── Role authorization factory ────────────────────────────────────────────────

/**
 * Inline role check for document routes.
 * Shorthand for authorize([...]) scoped to document operations.
 *
 * @param {string[]} allowedRoles
 * @returns {import('express').RequestHandler}
 *
 * @example
 *   router.post('/:id/publish', authenticate, enforceCampusAccess, requireDocRole(['ADMIN','DIRECTOR','CAMPUS_MANAGER']), publishDocument);
 */
const requireDocRole = (allowedRoles) => (req, res, next) => {
  if (!allowedRoles.includes(req.user.role)) {
    return sendForbidden(
      res,
      `Action requires one of the following roles: ${allowedRoles.join(', ')}`,
    );
  }
  next();
};

module.exports = {
  loadAndVerifyDocument,
  enforceDocumentTypeAccess,
  enforceTeacherScope,
  enforceStudentScope,
  enforceParentScope,
  enforceLockGuard,
  requireDocRole,
};