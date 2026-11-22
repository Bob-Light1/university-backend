'use strict';

/** @file audit-event.model.js @description Permanent immutable post-publication mutation events. */
const mongoose = require('mongoose');
const protectAuditDeletions = require('../../../shared/lib/protect-audit-deletions');
const { ACTION, SCOPE, ACTOR, ERROR, ENTITY_MODULE, auditError } = require('../audit.constants');
const { validateEvent } = require('../audit.validation');
const { Schema } = mongoose;
const childOptions = { _id: false, strict: 'throw' };
const schema = new Schema({
  schemaVersion: { type: Number, required: true, enum: [1] },
  mutationId: { type: String, required: true },
  operationId: { type: String, required: true },
  occurredAt: { type: Date, required: true },
  module: { type: String, required: true, enum: [...new Set(Object.values(ENTITY_MODULE))] },
  entityType: { type: String, required: true, enum: Object.keys(ENTITY_MODULE) },
  entityId: { type: Schema.Types.ObjectId, required: true },
  scope: { type: String, required: true, enum: Object.values(SCOPE) },
  schoolCampus: { type: Schema.Types.ObjectId, ref: 'Campus', default: null },
  partnerId: { type: Schema.Types.ObjectId, default: null },
  actor: { type: new Schema({
    kind: { type: String, required: true, enum: Object.values(ACTOR) },
    id: { type: Schema.Types.ObjectId, default: null },
    role: { type: String, default: null },
    source: { type: String, required: true },
  }, childOptions), required: true },
  action: { type: String, required: true, enum: Object.values(ACTION) },
  source: { type: new Schema({ module: String, operation: String }, childOptions), required: true },
  changes: { type: [Schema.Types.Mixed], required: true },
  reason: { type: String, default: null },
  related: { type: [new Schema({ entityType: String, entityId: Schema.Types.ObjectId }, childOptions)], default: [] },
}, { timestamps: true, strict: 'throw', collection: 'audit_events' });

schema.index({ mutationId: 1 }, { unique: true, name: 'audit_mutation_unique' });
schema.index({ schoolCampus: 1, occurredAt: -1, _id: -1 }, { name: 'audit_campus_time' });
schema.index({ entityType: 1, entityId: 1, occurredAt: -1, _id: -1 }, { name: 'audit_entity_time' });
schema.index({ partnerId: 1, schoolCampus: 1, occurredAt: -1, _id: -1 }, { name: 'audit_partner_time' });
schema.index({ scope: 1, occurredAt: -1, _id: -1 }, { name: 'audit_scope_time' });

/** Refuse an existing-document save before any validation or dispatch. */
function refuseExistingSave() {
  if (!this.isNew) throw auditError(ERROR.IMMUTABLE);
}

schema.pre('validate', function () { validateEvent(this.toObject()); });
schema.pre('save', function () {
  refuseExistingSave.call(this);
  validateEvent(this.toObject());
});
schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'], function () {
  throw auditError(ERROR.IMMUTABLE);
});
schema.pre('updateOne', { document: true, query: false }, function () { throw auditError(ERROR.IMMUTABLE); });
schema.pre('aggregate', function () {
  if (this.pipeline().some(stage => Object.hasOwn(stage, '$merge') || Object.hasOwn(stage, '$out'))) {
    throw auditError(ERROR.IMMUTABLE);
  }
});
schema.plugin(protectAuditDeletions, { errorFactory: () => auditError(ERROR.IMMUTABLE) });

schema.pre('insertMany', function (next, docs, options) {
  try {
    if (options?.lean) throw auditError(ERROR.INVALID_EVENT);
    docs.forEach(doc => validateEvent(doc instanceof mongoose.Document ? doc.toObject() : doc));
    next();
  } catch (error) { next(error); }
});
schema.pre('bulkWrite', function (next, operations) {
  try {
    if (operations.some(op => Object.keys(op).length !== 1 || !op.insertOne)) throw auditError(ERROR.IMMUTABLE);
    operations.forEach(op => validateEvent(op.insertOne.document));
    next();
  } catch (error) { next(error); }
});

module.exports = mongoose.model('AuditEvent', schema);
