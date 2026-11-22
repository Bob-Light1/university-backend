'use strict';

/** @file audit.projection.js @description Explicit source-owned scalar/redacted field projections. */
const mongoose = require('mongoose');
const { isDeepStrictEqual } = require('node:util');
const { TYPE, MODE, ENTITY_MODULE } = require('./audit.constants');
const { requireValid, onlyKeys, isId, isName } = require('./audit.validation');
const sources = new WeakMap();

/**
 * Declare a backend-owned source once, at module load. Dotted paths are deliberately
 * unsupported here: each emitter must project nested domain state into named fields.
 * @param {object} definition Closed entity, operations and explicit field rules.
 * @returns {object} Opaque frozen source handle, unsuitable for HTTP deserialization.
 */
function defineSource(definition) {
  onlyKeys(definition, ['entityType', 'operations', 'fields']);
  requireValid(Object.hasOwn(ENTITY_MODULE, definition.entityType));
  requireValid(Array.isArray(definition.operations) && definition.operations.length > 0 && definition.operations.every(isName));
  const fields = {};
  for (const [field, input] of Object.entries(definition.fields)) {
    requireValid(isName(field) && !field.includes('.') && !['__proto__', 'constructor', 'prototype'].includes(field));
    onlyKeys(input, ['type', 'values']);
    requireValid(Object.values(TYPE).includes(input.type));
    if (input.type === TYPE.ENUM) requireValid(Array.isArray(input.values) && input.values.length > 0 && input.values.every(isName));
    else requireValid(!Object.hasOwn(input, 'values'));
    fields[field] = Object.freeze({ type: input.type, ...(input.values ? { values: Object.freeze([...input.values]) } : {}) });
  }
  requireValid(Object.keys(fields).length > 0);
  const source = Object.freeze({ entityType: definition.entityType });
  sources.set(source, Object.freeze({ entityType: definition.entityType, operations: Object.freeze([...definition.operations]), fields: Object.freeze(fields) }));
  return source;
}

/** Resolve an opaque backend-owned source; plain request objects never qualify. */
function resolveSource(source) {
  requireValid(sources.has(source));
  return sources.get(source);
}

/** Normalize allowlisted typed values without accepting Mongoose coercions. */
function normalize(value, rule) {
  if (value === null) return null;
  switch (rule.type) {
    case TYPE.NUMBER: requireValid(typeof value === 'number' && Number.isFinite(value)); return value;
    case TYPE.BOOLEAN: requireValid(typeof value === 'boolean'); return value;
    case TYPE.DATE: requireValid(value instanceof Date && Number.isFinite(value.getTime())); return new Date(value.getTime());
    case TYPE.ID: requireValid(isId(value)); return new mongoose.Types.ObjectId(value.toString());
    case TYPE.ENUM: requireValid(rule.values.includes(value)); return value;
    default: requireValid(false);
  }
}

/**
 * Compare explicit persisted-state projections; unknown fields fail closed. Redacted
 * values are compared in memory, then discarded without hashes or presence flags.
 * @param {object} source Backend-owned opaque source handle.
 * @param {object} before Projection from the scoped persisted before-state.
 * @param {object} after Projection from the persisted after-state in the same transaction.
 * @returns {object[]} Actual normalized changes only.
 */
function projectChanges(source, before, after) {
  const { fields } = resolveSource(source);
  onlyKeys(before, Object.keys(fields));
  onlyKeys(after, Object.keys(fields));
  const changes = [];
  for (const field of Object.keys(fields)) {
    const hasBefore = Object.hasOwn(before, field);
    const hasAfter = Object.hasOwn(after, field);
    const rule = fields[field];
    if (hasBefore) requireValid(before[field] !== undefined);
    if (hasAfter) requireValid(after[field] !== undefined);
    const oldValue = hasBefore && rule.type !== TYPE.REDACTED ? normalize(before[field], rule) : before[field];
    const newValue = hasAfter && rule.type !== TYPE.REDACTED ? normalize(after[field], rule) : after[field];
    if (hasBefore === hasAfter && isDeepStrictEqual(oldValue, newValue)) continue;
    changes.push(rule.type === TYPE.REDACTED ? { field, mode: MODE.REDACTED } : {
      field, mode: MODE.VALUE, hasBefore, hasAfter,
      ...(hasBefore ? { before: oldValue } : {}), ...(hasAfter ? { after: newValue } : {}),
    });
  }
  return changes;
}

module.exports = { defineSource, resolveSource, projectChanges };
