'use strict';

/**
 * @file audit-ledger-records.js
 * @description Synthetic ledger payloads for isolated retention regressions, outside the seed dataset.
 */

const { oid, at } = require('../fixtures/ids');
const { DELETION_OUTCOME } = require('../../shared/lib/hard-delete/hard-delete.constants');

/**
 * Builds a valid ledger record with deterministic fixture identities and time.
 *
 * @param {import('mongoose').Model} Model
 * @param {string} [key]
 * @returns {object}
 */
const auditLedgerRecord = (Model, key = 'existing') => {
  const common = {
    _id: oid(`audit-retention:${Model.modelName}:${key}`),
    campusId: oid('campus:A'),
    performedAt: at(0),
  };

  if (Model.modelName === 'DocumentAudit') {
    return {
      ...common,
      documentId: oid('audit-retention:document'),
      action: Model.ACTION.UPDATE,
      userModel: 'System',
    };
  }
  if (Model.modelName === 'DeletionAudit') {
    return {
      ...common,
      entityType: 'document',
      entityModel: 'Document',
      entityId: oid('audit-retention:document'),
      entityIdentifier: 'SYNTHETIC-AUDIT-001',
      entityLabel: 'Synthetic audit retention record',
      performedBy: oid('audit-retention:actor'),
      performedByModel: 'Admin',
      performedByRole: 'ADMIN',
      reason: 'Synthetic retention regression',
      confirmationPhrase: 'DELETE SYNTHETIC-AUDIT-001',
      impactDigest: 'synthetic-impact-digest',
      passwordVerified: true,
      outcome: DELETION_OUTCOME.COMPLETED,
    };
  }
  throw new Error(`No synthetic audit payload for ${Model.modelName}`);
};

module.exports = { auditLedgerRecord };
