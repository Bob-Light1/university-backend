'use strict';

/** @file admission.helper.js @description Shared admission preconditions and transaction boundary. */
const mongoose = require('mongoose');
const repo = require('./admission.repository');
const { ADMISSION_ERRORS: E, admissionError, DRAFT_STATUSES } = require('../../shared/constants/admission.constants');

/** Every business mutation is retried as a unit; provider calls stay outside this callback. */
const transaction = (work) => mongoose.connection.transaction(work);

/** Resolve through the already authenticated campus filter. */
async function requireLead(id, campusFilter, session) {
  const lead = await repo.findLead({ _id: id, ...campusFilter }, { session });
  if (!lead) throw admissionError(E.NOT_FOUND, 'Lead not found', 404);
  return lead;
}

/** Require an explicit, non-negative optimistic revision. */
function revisionOf(value) {
  if (value === undefined || value === null || value === '' || !Number.isSafeInteger(Number(value)) || Number(value) < 0) {
    throw admissionError(E.INVALID, 'A valid dossier revision is required');
  }
  return Number(value);
}

/** Freeze preparation once submitted; decisions use the submitted immutable snapshot. */
function assertDraft(lead) {
  if (!DRAFT_STATUSES.includes(lead.status)) throw admissionError(E.CONFLICT, 'The submitted dossier is frozen', 409);
}

/** Turn a failed compare-and-swap into a conflict, never a reported successful mutation. */
function requireMutation(result) {
  if (!result) throw admissionError(E.CONFLICT, 'The dossier changed; reload it before retrying', 409);
  return result;
}

/** Status history contains operator text only; never credentials or storage references. */
const history = (status, actor, note = null) => ({ status, changedBy: String(actor), changedAt: new Date(), note });

module.exports = { transaction, requireLead, revisionOf, assertDraft, requireMutation, history };
