'use strict';

/**
 * @file hard-delete.guard.js
 * @description The four independent controls every permanent deletion must clear.
 *
 * Each control defends against a different failure, and none of them substitutes for another:
 *
 *  1. **Ticket** — an HMAC-signed token minted by the preview endpoint and bound to
 *     (actor, entity, impact digest). Without it there is no path to the execute endpoint,
 *     which means a deletion can never be fired blind: the operator provably saw the exact
 *     impact report the server computed, and if the database changed since (a result was
 *     published, a payment recorded), the digest no longer matches and the ticket is void.
 *  2. **Confirmation phrase** — the operator retypes `DELETE <identifier>` verbatim. Defends
 *     against the wrong row: a mis-click on a neighbouring line produces the wrong phrase.
 *  3. **Password re-authentication** — proves the human at the keyboard is the account owner,
 *     not a walked-away session or a stolen JWT.
 *  4. **Reason** — a written justification, stored in the audit ledger forever.
 *
 * The ticket is stateless by design: signed with JWT_SECRET, 5-minute TTL, single entity.
 * There is no server-side store to grow, and a restart does not strand an operator mid-flow.
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');

const {
  buildConfirmationPhrase,
  MIN_REASON_LENGTH,
  MAX_REASON_LENGTH,
  TICKET_TTL_SECONDS,
} = require('./hard-delete.constants');

/** Domain separator — a ticket can never be confused with any other HMAC in the platform. */
const TICKET_CONTEXT = 'hard-delete-ticket:v1';

/**
 * Resolves the secret used to sign deletion tickets.
 *
 * @returns {string}
 * @throws {Error} When JWT_SECRET is absent — fail closed rather than sign with a fallback.
 */
const getSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('hard-delete: JWT_SECRET is required to sign deletion tickets');
  }
  return secret;
};

/**
 * Stable digest of an impact report. Any change to the counts — a result published, a payment
 * recorded, a child row added between preview and execute — changes the digest and invalidates
 * the ticket, forcing the operator through a fresh preview.
 *
 * The label is part of the canonical form, not decoration: several entries declare more than
 * one relation over the same model in the same mode (a teacher BLOCKs `ExamGrading` both as
 * grader and as second grader; a class DETACHes `Class` twice). Keyed on model and mode alone,
 * those lines are interchangeable, so counts moving from one to the other leave the digest
 * unchanged and a stale ticket still verifies. The label is what separates them.
 *
 * @param {Array<{ model: string, label: string, mode: string, count: number }>} impact
 * @returns {string} 32-char hex digest.
 */
const digestImpact = (impact) => {
  const canonical = [...impact]
    .map((line) => `${line.model}:${line.label}:${line.mode}:${line.count}`)
    .sort()
    .join('|');

  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
};

/**
 * Mints a deletion ticket. Called only by the preview endpoint.
 *
 * @param {Object} params
 * @param {string} params.actorId
 * @param {string} params.entityType
 * @param {string} params.entityId
 * @param {string} params.impactDigest
 * @returns {{ ticket: string, expiresAt: string }}
 */
const issueTicket = ({ actorId, entityType, entityId, impactDigest }) => {
  const expiresAt = Date.now() + TICKET_TTL_SECONDS * 1000;

  const payload = [
    TICKET_CONTEXT,
    String(actorId),
    entityType,
    String(entityId),
    impactDigest,
    String(expiresAt),
  ].join('.');

  const signature = crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');

  return {
    ticket:    `${Buffer.from(payload).toString('base64url')}.${signature}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
};

/**
 * Verifies a deletion ticket against the operation actually being requested.
 *
 * @param {string} ticket
 * @param {Object} expected
 * @param {string} expected.actorId
 * @param {string} expected.entityType
 * @param {string} expected.entityId
 * @param {string} expected.impactDigest - Digest recomputed at execution time.
 * @returns {{ valid: boolean, error?: string }}
 */
const verifyTicket = (ticket, { actorId, entityType, entityId, impactDigest }) => {
  if (typeof ticket !== 'string' || !ticket.includes('.')) {
    return { valid: false, error: 'A deletion ticket from the impact preview is required' };
  }

  const separator = ticket.lastIndexOf('.');
  const encoded   = ticket.slice(0, separator);
  const signature = ticket.slice(separator + 1);

  let payload;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return { valid: false, error: 'Malformed deletion ticket' };
  }

  const expectedSignature = crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');

  // Constant-time compare; length check first because timingSafeEqual throws on mismatch.
  const provided = Buffer.from(signature);
  const computed = Buffer.from(expectedSignature);
  if (provided.length !== computed.length || !crypto.timingSafeEqual(provided, computed)) {
    return { valid: false, error: 'Invalid deletion ticket signature' };
  }

  const [context, ticketActor, ticketType, ticketEntity, ticketDigest, ticketExpiry] = payload.split('.');

  if (context !== TICKET_CONTEXT) {
    return { valid: false, error: 'Invalid deletion ticket' };
  }
  if (Number(ticketExpiry) < Date.now()) {
    return { valid: false, error: 'Deletion ticket expired — re-run the impact preview' };
  }
  if (ticketActor !== String(actorId)) {
    return { valid: false, error: 'This deletion ticket was issued to another user' };
  }
  if (ticketType !== entityType || ticketEntity !== String(entityId)) {
    return { valid: false, error: 'This deletion ticket was issued for another entity' };
  }
  if (ticketDigest !== impactDigest) {
    return {
      valid: false,
      error: 'The data changed since the preview was generated — re-run the impact preview',
    };
  }

  return { valid: true };
};

/**
 * Checks the phrase typed by the operator against the server-computed expectation.
 * Comparison is case-insensitive on the verb and identifier but whitespace-normalised, so
 * `delete stu-2024-0031` passes while `STU-2024-0031` alone does not.
 *
 * @param {string} typed
 * @param {string} identifier - Business key of the target.
 * @returns {{ valid: boolean, expected: string }}
 */
const verifyConfirmationPhrase = (typed, identifier) => {
  const expected   = buildConfirmationPhrase(identifier);
  const normalised = String(typed ?? '').trim().replace(/\s+/g, ' ').toUpperCase();

  return { valid: normalised === expected, expected };
};

/**
 * Validates the mandatory justification.
 *
 * @param {string} reason
 * @returns {{ valid: boolean, error?: string, value?: string }}
 */
const verifyReason = (reason) => {
  const value = String(reason ?? '').trim();

  if (value.length < MIN_REASON_LENGTH) {
    return { valid: false, error: `A justification of at least ${MIN_REASON_LENGTH} characters is required` };
  }
  if (value.length > MAX_REASON_LENGTH) {
    return { valid: false, error: `The justification must not exceed ${MAX_REASON_LENGTH} characters` };
  }

  return { valid: true, value };
};

/**
 * Maps an authenticated role to the collection that actually holds its credentials.
 * ADMIN and DIRECTOR are both rows of the `Admin` collection (admin.model ADMIN_ROLES);
 * a CAMPUS_MANAGER authenticates as the Campus document itself.
 *
 * Any other role is rejected: it has no business reaching the danger zone, and guessing a
 * credential store would be exactly the kind of silent failure this module exists to prevent.
 *
 * @param {string} role
 * @returns {{ model: import('mongoose').Model, name: string }|null}
 */
const resolveActorModel = (role) => {
  switch (role) {
    case 'ADMIN':
    case 'DIRECTOR':
      return { model: require('../../../modules/admin/admin.model'), name: 'Admin' };
    case 'CAMPUS_MANAGER':
      return { model: require('../../../modules/campus/campus.model'), name: 'Campus' };
    default:
      return null;
  }
};

/**
 * Re-authenticates the operator against their own account.
 *
 * `password` is `select: false` on both credential models, so it is explicitly selected here
 * and never leaves this function.
 *
 * @param {Object} user - `req.user` (decoded JWT).
 * @param {string} password - Password submitted with the deletion request.
 * @returns {Promise<{ valid: boolean, error?: string, actorModel?: string }>}
 */
const verifyActorPassword = async (user, password) => {
  if (!password || typeof password !== 'string') {
    return { valid: false, error: 'Your password is required to confirm a permanent deletion' };
  }

  const actor = resolveActorModel(user.role);
  if (!actor) {
    return { valid: false, error: 'Your role cannot perform permanent deletions' };
  }

  const account = await actor.model.findById(user.id).select('+password').lean();
  if (!account?.password) {
    return { valid: false, error: 'Unable to verify your credentials' };
  }

  const matches = await bcrypt.compare(password, account.password);
  if (!matches) {
    return { valid: false, error: 'Incorrect password' };
  }

  return { valid: true, actorModel: actor.name };
};

module.exports = {
  digestImpact,
  issueTicket,
  verifyTicket,
  verifyConfirmationPhrase,
  verifyReason,
  verifyActorPassword,
  resolveActorModel,
};
