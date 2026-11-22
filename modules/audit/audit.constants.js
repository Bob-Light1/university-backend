'use strict';

/** @file audit.constants.js @description Frozen shared-journal vocabulary and limits. */

const ACTION = Object.freeze({
  UPDATE: 'update', ARCHIVE: 'archive', RESTORE: 'restore', DELETE: 'delete',
  LOCK: 'lock', UNLOCK: 'unlock', SIGN: 'sign', GRANT: 'grant',
  TRANSITION: 'transition', CONFIGURE: 'configure',
});
const SCOPE = Object.freeze({ CAMPUS: 'campus', GLOBAL: 'global' });
const ACTOR = Object.freeze({ USER: 'user', SYSTEM: 'system', CAPABILITY: 'capability', ANONYMOUS: 'anonymous' });
const MODE = Object.freeze({ VALUE: 'value', REDACTED: 'redacted' });
const TYPE = Object.freeze({ NUMBER: 'number', BOOLEAN: 'boolean', DATE: 'date', ID: 'id', ENUM: 'enum', REDACTED: 'redacted' });
const ERROR = Object.freeze({
  INVALID_EVENT: 'AUDIT_INVALID_EVENT', SCOPE_REQUIRED: 'AUDIT_SCOPE_REQUIRED',
  TRANSACTION_REQUIRED: 'AUDIT_TRANSACTION_REQUIRED', IMMUTABLE: 'AUDIT_IMMUTABLE',
});
const LIMIT = Object.freeze({ CHANGES: 128, RELATED: 50, REASON: 1000, NAME: 100 });
const ENTITY_MODULE = Object.freeze({
  Result: 'result', FinalTranscript: 'result', ExamGrading: 'exam', ExamSession: 'exam',
  StudentSchedule: 'student', TeacherSchedule: 'teacher', Document: 'document',
  Announcement: 'announcement', Course: 'course', Expense: 'finance', Income: 'finance',
  StudentFee: 'finance', FeePayment: 'finance', PartnerLead: 'partner', PartnerCommission: 'partner',
  Testimonial: 'public-portal', FaqEntry: 'public-portal', CoursePreview: 'public-portal',
  CompetitionPrize: 'public-portal', QuizQuestion: 'public-portal', AuditConsultationPolicy: 'audit',
});
const REFERENCE_TYPES = Object.freeze([...Object.keys(ENTITY_MODULE), 'ExamAppeal', 'DocumentAudit', 'DeletionAudit', 'DocumentShare', 'DocumentVersion', 'Student']);

/** Return a bounded public error without including rejected data. */
function auditError(code) {
  return Object.assign(new Error(code), { code });
}

module.exports = Object.freeze({ ACTION, SCOPE, ACTOR, MODE, TYPE, ERROR, LIMIT, ENTITY_MODULE, REFERENCE_TYPES, auditError });
