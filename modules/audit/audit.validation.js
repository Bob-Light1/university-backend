'use strict';

/** @file audit.validation.js @description Strict journal validation before persistence and casting. */
const { isDeepStrictEqual } = require('node:util');
const mongoose = require('mongoose');
const { ACTION, SCOPE, ACTOR, MODE, ERROR, LIMIT, ENTITY_MODULE, REFERENCE_TYPES, auditError } = require('./audit.constants');
const ID = /^[a-f\d]{24}$/i;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const NAME = /^[a-zA-Z][a-zA-Z\d_.-]*$/;
const ROLES = new Set(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER', 'STUDENT', 'PARENT', 'MENTOR', 'STAFF', 'PARTNER']);

/** Refuse malformed data with a stable error that never echoes the input. */
function requireValid(condition, code = ERROR.INVALID_EVENT) {
  if (!condition) throw auditError(code);
}

/** Only raw ObjectIds and exact hexadecimal strings qualify as IDs. */
function isId(value) {
  return value instanceof mongoose.Types.ObjectId || (typeof value === 'string' && ID.test(value));
}

/** Reject unknown object keys instead of silently discarding private data. */
function onlyKeys(value, keys) {
  requireValid(value && typeof value === 'object' && !Array.isArray(value));
  requireValid(Object.keys(value).every(key => keys.includes(key)));
}

/** Test an internal operation/field name without accepting URLs or arbitrary prose. */
function isName(value) {
  return typeof value === 'string' && value.length <= LIMIT.NAME && NAME.test(value);
}

/** Reject metadata/provenance inconsistencies independently of model casting. */
function validateMetadata(data) {
  requireValid(Object.hasOwn(ENTITY_MODULE, data.entityType));
  requireValid(data.module === ENTITY_MODULE[data.entityType] && isId(data.entityId));
  const expectedScope = data.entityType === 'Course' ? SCOPE.GLOBAL : SCOPE.CAMPUS;
  requireValid(Object.values(SCOPE).includes(data.scope), ERROR.SCOPE_REQUIRED);
  if (data.entityType !== 'AuditConsultationPolicy') requireValid(data.scope === expectedScope, ERROR.SCOPE_REQUIRED);
  requireValid(data.scope === SCOPE.CAMPUS ? isId(data.schoolCampus) : data.schoolCampus === null, ERROR.SCOPE_REQUIRED);
  requireValid(data.partnerId === null || (['PartnerLead', 'PartnerCommission'].includes(data.entityType) && isId(data.partnerId)));
  if (data.entityType === 'PartnerCommission') requireValid(isId(data.partnerId));
  requireValid(Object.values(ACTION).includes(data.action));
  onlyKeys(data.source, ['module', 'operation']);
  requireValid(data.source.module === data.module && isName(data.source.operation));
  onlyKeys(data.actor, ['kind', 'id', 'role', 'source']);
  requireValid(Object.values(ACTOR).includes(data.actor.kind));
  requireValid(data.actor.source === data.source.operation);
  if (data.actor.kind === ACTOR.USER) {
    requireValid(isId(data.actor.id) && ROLES.has(data.actor.role));
  } else {
    requireValid(data.actor.id === null && data.actor.role === null);
  }
  requireValid(data.reason === null || (typeof data.reason === 'string' && data.reason.length <= LIMIT.REASON));
  requireValid(Array.isArray(data.related) && data.related.length <= LIMIT.RELATED);
  data.related.forEach(ref => {
    onlyKeys(ref, ['entityType', 'entityId']);
    requireValid(REFERENCE_TYPES.includes(ref.entityType) && isId(ref.entityId));
  });
}

/** Validate projected scalar values; nested content is never stored as a value. */
function isScalar(value) {
  return value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && isName(value)) || value instanceof mongoose.Types.ObjectId ||
    (value instanceof Date && Number.isFinite(value.getTime()));
}

/** Validate the persisted event contract, including absence versus null and no-ops. */
function validateEvent(data) {
  onlyKeys(data, ['_id', '__v', 'schemaVersion', 'mutationId', 'operationId', 'occurredAt', 'createdAt', 'updatedAt',
    'module', 'entityType', 'entityId', 'scope', 'schoolCampus', 'partnerId', 'actor', 'action', 'source', 'changes', 'reason', 'related']);
  validateMetadata(data);
  requireValid(data.schemaVersion === 1 && UUID.test(data.mutationId) && UUID.test(data.operationId));
  requireValid(data.occurredAt instanceof Date && Number.isFinite(data.occurredAt.getTime()));
  requireValid(Array.isArray(data.changes) && data.changes.length > 0 && data.changes.length <= LIMIT.CHANGES);
  const fields = new Set();
  data.changes.forEach(change => {
    requireValid(isName(change.field) && !fields.has(change.field));
    fields.add(change.field);
    if (change.mode === MODE.REDACTED) {
      onlyKeys(change, ['field', 'mode']);
      return;
    }
    onlyKeys(change, ['field', 'mode', 'hasBefore', 'hasAfter', 'before', 'after']);
    requireValid(change.mode === MODE.VALUE && typeof change.hasBefore === 'boolean' && typeof change.hasAfter === 'boolean');
    for (const [flag, key] of [['hasBefore', 'before'], ['hasAfter', 'after']]) {
      requireValid(change[flag] === Object.hasOwn(change, key));
      if (change[flag]) requireValid(isScalar(change[key]));
    }
    requireValid(change.hasBefore !== change.hasAfter || !isDeepStrictEqual(change.before, change.after));
  });
}

module.exports = { requireValid, isId, onlyKeys, isName, validateMetadata, validateEvent };
