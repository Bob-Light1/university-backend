'use strict';

/**
 * @file hard-delete.constants.js
 * @description Frozen enums and tunables shared by the harmonized hard-delete pipeline.
 *
 * These values are the contract between the backend, the DeletionAudit collection and the
 * frontend danger-zone dialog. The frontend mirrors them — the backend is the source of truth
 * (CLAUDE.md §5). Never inline these literals anywhere else.
 */

/**
 * How a related document is treated when its owner is hard-deleted.
 *
 *  - BLOCK   : the deletion is refused while at least one such document exists.
 *              Reserved for official academic / financial records that must survive
 *              an operator mistake (results, transcripts, payments, published documents).
 *  - CASCADE : the related documents are hard-deleted inside the same transaction.
 *              Reserved for derived, operational rows that carry no standalone value.
 *  - DETACH  : the reference to the deleted entity is unset / pulled, the related
 *              document itself is kept.
 *  - RETAIN  : the reference is deliberately LEFT pointing at the removed id, because it is
 *              historical provenance ("who recorded this attendance line") stored in a
 *              required field. Unsetting it would break the schema of a surviving document
 *              and erase audit information; blocking on it would make any actor who ever
 *              touched a record permanently undeletable. RETAIN exists so that case is
 *              declared, counted and shown to the operator instead of being the implicit
 *              default nobody wrote down.
 */
const RELATION_MODE = Object.freeze({
  BLOCK:   'block',
  CASCADE: 'cascade',
  DETACH:  'detach',
  RETAIN:  'retain',
});

/**
 * Outcome recorded on every DeletionAudit entry. An audit row is written for refusals too —
 * a blocked attempt is exactly the signal a security review needs.
 */
const DELETION_OUTCOME = Object.freeze({
  COMPLETED: 'completed',
  BLOCKED:   'blocked',
  FAILED:    'failed',
});

/**
 * Verb the operator must type, verbatim, in front of the entity identifier.
 * The full expected phrase is built by {@link buildConfirmationPhrase} and returned by the
 * preview endpoint — the frontend never composes it on its own.
 */
const CONFIRMATION_VERB = 'DELETE';

/** Minimum length of the mandatory free-text justification, mirrored by the frontend. */
const MIN_REASON_LENGTH = 10;

/** Maximum length of the justification (kept well under the audit field cap). */
const MAX_REASON_LENGTH = 500;

/**
 * Lifetime of a deletion ticket, in seconds. A ticket is issued by the preview endpoint and
 * is the only way to reach the execute endpoint: it proves the operator was shown — and the
 * server computed — the exact impact report they are approving.
 */
const TICKET_TTL_SECONDS = 300;

/**
 * Upper bound applied to every impact count.
 *
 * `countDocuments()` scans, and the impact report runs one count per declared relation over
 * collections that hold millions of rows in a mature tenant. The operator does not need an
 * exact figure past this point — "more than 10 000 attendance records" and "10 431 attendance
 * records" lead to the same decision — and a capped count also makes the ticket digest stable
 * while rows keep arriving underneath a long-lived preview.
 *
 * Lines that hit the cap are flagged `capped: true` so the UI can render "10 000+".
 */
const IMPACT_COUNT_LIMIT = 10000;

/**
 * Maximum number of documents a single deletion may CASCADE.
 *
 * Cascades run inside one MongoDB transaction, which is bounded by the 16 MB oplog entry and
 * the 60-second default lifetime. Past a few thousand documents the transaction aborts
 * mid-flight and the operator gets an opaque 500 after a long hang. Refusing up front, with a
 * message that says what to do instead, is the honest failure.
 */
const MAX_CASCADE_DOCUMENTS = 5000;

/**
 * Roles allowed to reach the danger-zone router at all — the union of every `roles` array in
 * the registry. This is the coarse gate; the real authorization is per entity and lives in
 * hard-delete.registry.js, which `resolveEntry()` enforces on both preview and execute.
 * A CAMPUS_MANAGER reaching this router still gets a 403 on every entity but its own.
 */
const DANGER_ZONE_ROLES = Object.freeze(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']);

/**
 * Builds the exact phrase the operator must type to confirm a permanent deletion.
 * Deterministic and server-computed on both the preview and the execute call, so a stale or
 * hand-crafted phrase can never match.
 *
 * @param {string} identifier - Stable business key of the target (matricule, code, username…).
 * @returns {string} e.g. `DELETE STU-2024-0031`
 */
const buildConfirmationPhrase = (identifier) =>
  `${CONFIRMATION_VERB} ${String(identifier ?? '').trim().toUpperCase()}`.trim();

module.exports = {
  RELATION_MODE,
  DELETION_OUTCOME,
  CONFIRMATION_VERB,
  MIN_REASON_LENGTH,
  MAX_REASON_LENGTH,
  TICKET_TTL_SECONDS,
  IMPACT_COUNT_LIMIT,
  MAX_CASCADE_DOCUMENTS,
  DANGER_ZONE_ROLES,
  buildConfirmationPhrase,
};
