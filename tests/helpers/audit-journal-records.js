'use strict';

/** @file audit-journal-records.js @description Synthetic projected state for journal foundation checks. */
const mongoose = require('mongoose');
const { service, constants: { ACTION, ACTOR, SCOPE, TYPE } } = require('../../modules/audit');
const { STATUSES } = require('../../modules/finance/fee-status');

const source = service.defineSource({
  entityType: 'StudentFee', operations: ['recordPayment'], fields: {
    amountPaid: { type: TYPE.NUMBER }, status: { type: TYPE.ENUM, values: STATUSES },
    label: { type: TYPE.REDACTED }, dueDate: { type: TYPE.DATE }, student: { type: TYPE.ID },
    isDeleted: { type: TYPE.BOOLEAN },
  },
});

/** Construct verified synthetic metadata; never use generated fixture credentials. */
function metadata(overrides = {}) {
  return {
    entityId: new mongoose.Types.ObjectId(), scope: SCOPE.CAMPUS, schoolCampus: new mongoose.Types.ObjectId(),
    actor: { kind: ACTOR.USER, id: new mongoose.Types.ObjectId(), role: 'ADMIN', source: 'recordPayment' },
    action: ACTION.UPDATE, operation: 'recordPayment', ...overrides,
  };
}

/** Valid raw event for exercising the actual model API guards. */
function eventRecord() {
  const { randomUUID } = require('node:crypto');
  const data = metadata();
  return {
    schemaVersion: 1, mutationId: randomUUID(), operationId: randomUUID(), occurredAt: new Date(),
    module: 'finance', entityType: 'StudentFee', entityId: data.entityId,
    scope: data.scope, schoolCampus: data.schoolCampus, partnerId: null, actor: data.actor,
    action: data.action, source: { module: 'finance', operation: data.operation }, reason: null, related: [],
    changes: [{ field: 'amountPaid', mode: 'value', hasBefore: true, hasAfter: true, before: 0, after: 20 }],
  };
}

module.exports = { source, metadata, eventRecord };
