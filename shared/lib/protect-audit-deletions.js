'use strict';

/**
 * @file protect-audit-deletions.js
 * @description Protects permanent audit history through Mongoose deletion middleware.
 */

/**
 * Installs query, document and whole-batch deletion guards before model compilation.
 * Existing insertion and update behavior is deliberately preserved.
 *
 * @param {import('mongoose').Schema} schema
 * @returns {void}
 */
const protectAuditDeletions = (schema) => {
  const deletionError = (modelName) =>
    new Error(`${modelName} records are immutable — deletion is not permitted`);

  /** @returns {never} Rejects an individual ledger deletion before database access. */
  const refuseDeletion = function () {
    const modelName = this.model?.modelName || this.constructor.modelName;
    throw deletionError(modelName);
  };

  schema.pre('deleteOne', { document: true, query: true }, refuseDeletion);
  schema.pre('deleteMany', refuseDeletion);
  schema.pre('findOneAndDelete', refuseDeletion);

  // Model.bulkWrite bypasses individual query/document hooks. Refuse the whole
  // batch before casting or dispatch, so unordered writes cannot partially run.
  schema.pre('bulkWrite', function (next, operations) {
    if (operations.some((operation) => operation.deleteOne || operation.deleteMany)) {
      return next(deletionError(this.modelName));
    }
    return next();
  });
};

module.exports = protectAuditDeletions;
