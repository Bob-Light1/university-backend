'use strict';

/** @file audit.service.js @description Retry-stable mutation identities and atomic projected appends. */
const { randomUUID } = require('node:crypto');
const { mongo: { BSON: { EJSON } } } = require('mongoose');
const repository = require('./audit.repository');
const { ENTITY_MODULE } = require('./audit.constants');
const { requireValid, onlyKeys, validateMetadata } = require('./audit.validation');
const { defineSource, resolveSource, projectChanges } = require('./audit.projection');
const operations = new WeakMap();
const mutations = new WeakMap();

/** Allocate one server-generated correlation identity outside a transaction retry. */
function createOperation() {
  const operation = Object.freeze({});
  operations.set(operation, randomUUID());
  return operation;
}

/**
 * Allocate the logical entity mutation outside withTransaction. Identity and provenance
 * are detached from caller-owned objects. The emitter supplies verified server context.
 * @param {object} source Opaque source declaration from defineSource.
 * @param {object} metadata Entity, actual scope and server-verified actor/action.
 * @param {object} [operation] Shared opaque correlation handle for related effects.
 * @returns {object} Opaque mutation handle; retain across transaction callback retries.
 */
function createMutation(source, metadata, operation = createOperation()) {
  const definition = resolveSource(source);
  requireValid(operations.has(operation));
  onlyKeys(metadata, ['entityId', 'scope', 'schoolCampus', 'partnerId', 'actor', 'action', 'operation', 'reason', 'related']);
  requireValid(definition.operations.includes(metadata.operation));
  const event = {
    schemaVersion: 1, mutationId: randomUUID(), operationId: operations.get(operation), occurredAt: new Date(),
    module: ENTITY_MODULE[definition.entityType], entityType: definition.entityType,
    entityId: metadata.entityId, scope: metadata.scope, schoolCampus: metadata.schoolCampus,
    partnerId: metadata.partnerId ?? null, actor: metadata.actor, action: metadata.action,
    source: { module: ENTITY_MODULE[definition.entityType], operation: metadata.operation },
    reason: metadata.reason ?? null, related: metadata.related ?? [],
  };
  validateMetadata(event);
  // EJSON preserves typed IDs/dates while detaching nested caller objects.
  const detached = EJSON.parse(EJSON.stringify(event));
  const mutation = Object.freeze({});
  mutations.set(mutation, { source, event: detached });
  return mutation;
}

/**
 * Project actual states on every retry and append in the existing business transaction.
 * No-op mutations return null; event insertion errors must propagate to the caller.
 * @param {object} mutation Opaque retry-stable mutation handle.
 * @param {object} options Persisted before/after projections and active session.
 * @returns {Promise<object|null>} Appended event, or null for equal projections.
 */
async function appendMutation(mutation, { before, after, session }) {
  requireValid(mutations.has(mutation));
  repository.requireTransaction(session);
  const { source, event } = mutations.get(mutation);
  const changes = projectChanges(source, before, after);
  if (!changes.length) return null;
  return repository.append({ ...event, changes }, session);
}

module.exports = { defineSource, createOperation, createMutation, appendMutation };
