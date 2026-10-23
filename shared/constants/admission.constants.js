'use strict';

/** @file admission.constants.js @description Canonical admission workflow and private dossier limits. */
const LEAD_STATUS = Object.freeze({
  NEW: 'new', CONTACTED: 'contacted', SUBMITTED: 'dossier_submitted', ADMITTED: 'admitted',
  ENROLLED: 'enrolled', REJECTED: 'rejected', ABANDONED: 'abandoned',
});
const TRANSITIONS = Object.freeze({
  new: Object.freeze(['contacted', 'dossier_submitted', 'rejected', 'abandoned']),
  contacted: Object.freeze(['dossier_submitted', 'rejected', 'abandoned']),
  dossier_submitted: Object.freeze(['admitted', 'rejected', 'abandoned']),
  admitted: Object.freeze(['enrolled', 'rejected', 'abandoned']),
  enrolled: Object.freeze([]), rejected: Object.freeze([]), abandoned: Object.freeze([]),
});
const ATTACHMENT_CATEGORIES = Object.freeze(['identity', 'diploma', 'transcript', 'other']);
const MANAGEMENT_ROLES = Object.freeze(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']);
const ADMISSION_ROLES = Object.freeze(['ADMIN', 'DIRECTOR']);
const DRAFT_STATUSES = Object.freeze([LEAD_STATUS.NEW, LEAD_STATUS.CONTACTED]);
const DOSSIER_LIMITS = Object.freeze({ maxFileBytes: 5 * 1024 * 1024, maxFiles: 10, capabilityHours: 72 });
const ADMISSION_ERRORS = Object.freeze({
  INVALID: 'ADMISSION_INVALID', NOT_FOUND: 'ADMISSION_NOT_FOUND', FORBIDDEN: 'ADMISSION_FORBIDDEN',
  CONFLICT: 'ADMISSION_CONFLICT', INCOMPLETE: 'ADMISSION_INCOMPLETE', QUOTA: 'ADMISSION_QUOTA',
  DUPLICATE: 'ADMISSION_DUPLICATE_STUDENT', CAPABILITY: 'ADMISSION_INVALID_ACCESS',
  HISTORICAL: 'ADMISSION_HISTORICAL_ENROLLMENT', FILE: 'ADMISSION_INVALID_FILE',
});

/** Build a typed business error consumed by the common admission response adapter. */
function admissionError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

module.exports = {
  LEAD_STATUS, TRANSITIONS, ATTACHMENT_CATEGORIES, MANAGEMENT_ROLES, ADMISSION_ROLES,
  DRAFT_STATUSES, DOSSIER_LIMITS, ADMISSION_ERRORS, admissionError,
};
