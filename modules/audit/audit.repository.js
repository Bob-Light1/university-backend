'use strict';

/** @file audit.repository.js @description Insert-only journal persistence in an owning transaction. */
const AuditEvent = require('./models/audit-event.model');
const { mongo: { ClientSession } } = require('mongoose');
const { ERROR } = require('./audit.constants');
const { requireValid, validateEvent } = require('./audit.validation');

/** Refuse inactive, spoofed or foreign-client sessions before projection or persistence. */
function requireTransaction(session) {
  requireValid(session instanceof ClientSession && session.inTransaction() &&
    session.client === AuditEvent.db.getClient(), ERROR.TRANSACTION_REQUIRED);
}

/**
 * Append without upsert or duplicate suppression. Duplicate IDs abort the transaction.
 * @param {object} event Validated projected event.
 * @param {import('mongoose').ClientSession} session Active session on the event connection.
 * @returns {Promise<object>} Inserted event without population dependencies.
 */
async function append(event, session) {
  requireTransaction(session);
  validateEvent(event);
  const [created] = await AuditEvent.create([event], { session });
  return created.toObject();
}

module.exports = { append, requireTransaction };
