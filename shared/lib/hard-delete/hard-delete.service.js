'use strict';

/**
 * @file hard-delete.service.js
 * @description The single code path through which any permanent deletion happens.
 *
 * Two operations, deliberately split:
 *
 *   preview()  — read-only. Computes the impact report, tells the operator what would be
 *                destroyed, what blocks the deletion, and which phrase they will have to type.
 *                Mints the ticket that authorizes the second call.
 *   execute()  — re-runs every check from scratch (nothing from the preview is trusted except
 *                the signed ticket), then performs the removal inside a transaction.
 *
 * Invariants this module guarantees:
 *
 *   - No hard delete without a DeletionAudit row. Refusals are audited too.
 *   - No hard delete of a live entity: the target must already be soft-deleted, so every
 *     permanent deletion is a *second*, separate decision taken after the first one.
 *   - No orphan references: every relation in the registry is either BLOCKed, CASCADEd or
 *     DETACHed — there is no fourth, implicit "leave it dangling" case.
 *   - Atomicity: cascades, detaches, the document itself and its audit row commit together.
 */

const mongoose = require('mongoose');

const { deletedOnlyFilter, isSoftDeletable } = require('../../utils/soft-delete');
const { isValidObjectId } = require('../../utils/validation-helpers');
const { deleteFile } = require('../../utils/file-upload');

const DeletionAudit = require('./deletion-audit.model');
const { getEntry, resolveRelationModel } = require('./hard-delete.registry');
const {
  RELATION_MODE,
  DELETION_OUTCOME,
  IMPACT_COUNT_LIMIT,
  MAX_CASCADE_DOCUMENTS,
  MIN_REASON_LENGTH,
  MAX_REASON_LENGTH,
  AUDIT_FIELD_LIMITS,
  buildConfirmationPhrase,
  truncateForAudit,
} = require('./hard-delete.constants');
const {
  digestImpact,
  issueTicket,
  verifyTicket,
  verifyConfirmationPhrase,
  verifyReason,
  verifyActorPassword,
} = require('./hard-delete.guard');

const GLOBAL_ROLES = ['ADMIN', 'DIRECTOR'];

/**
 * Builds an Error carrying an HTTP status, matching the convention used by the document and
 * account services so controllers can map it without a translation table.
 *
 * @param {number} statusCode
 * @param {string} message
 * @param {Object} [extra] - Additional payload merged onto the error (e.g. `blockers`).
 * @returns {Error}
 */
const httpError = (statusCode, message, extra = {}) =>
  Object.assign(new Error(message), { statusCode, ...extra });

// ── Resolution ────────────────────────────────────────────────────────────────

/**
 * Resolves the registry entry and enforces the role gate.
 *
 * @param {string} entityType
 * @param {Object} user - req.user
 * @returns {import('./hard-delete.registry').HardDeleteEntry}
 * @throws {Error} 400 for an unknown type, 403 for an insufficient role.
 */
const resolveEntry = (entityType, user) => {
  const entry = getEntry(entityType);

  if (!entry) {
    throw httpError(400, `'${entityType}' is not a permanently deletable entity`);
  }
  if (!entry.roles.includes(user.role)) {
    throw httpError(403, `Permanent deletion of a ${entry.label.toLowerCase()} requires one of: ${entry.roles.join(', ')}`);
  }

  return entry;
};

/**
 * Campus isolation for the danger zone (CLAUDE.md §2). Global roles are unscoped; every other
 * role is pinned to its own campus and is denied outright on global collections, where a
 * campus filter would be meaningless and therefore silently absent.
 *
 * @param {import('./hard-delete.registry').HardDeleteEntry} entry
 * @param {Object} user
 * @returns {Object} Filter fragment.
 */
const buildScopeFilter = (entry, user) => {
  if (GLOBAL_ROLES.includes(user.role)) return {};

  if (!entry.campusPath) {
    throw httpError(403, `A ${user.role} cannot delete from a global collection`);
  }
  if (!user.campusId || !isValidObjectId(String(user.campusId))) {
    throw httpError(403, 'Campus isolation breach prevented: no valid campusId on your account');
  }

  return { [entry.campusPath]: user.campusId };
};

/**
 * Loads the target document, enforcing campus scope.
 *
 * @param {import('./hard-delete.registry').HardDeleteEntry} entry
 * @param {string} entityId
 * @param {Object} user
 * @returns {Promise<Object>} Lean document.
 * @throws {Error} 400 on a malformed id, 404 when absent or out of scope.
 */
const loadTarget = async (entry, entityId, user) => {
  if (!isValidObjectId(entityId)) {
    throw httpError(400, `Invalid ${entry.label.toLowerCase()} ID format`);
  }

  const Model = entry.model();
  const doc = await Model.findOne({ _id: entityId, ...buildScopeFilter(entry, user) }).lean();

  if (!doc) throw httpError(404, `${entry.label} not found`);

  return doc;
};

/**
 * Enforces the "archive first" rule: a permanent deletion is only ever the confirmation of an
 * earlier soft delete, never the first thing that happens to a live record.
 *
 * Skipped for models with no soft-delete convention (CLAUDE.md §5.1) — for those, `archive
 * first` is not expressible, and the entry declares `requireArchivedFirst: false`.
 *
 * @param {import('./hard-delete.registry').HardDeleteEntry} entry
 * @param {string} entityId
 * @throws {Error} 409 when the entity is still live.
 */
const assertAlreadySoftDeleted = async (entry, entityId) => {
  if (!entry.requireArchivedFirst) return;

  const Model = entry.model();
  if (!isSoftDeletable(Model)) return;

  const archived = await Model.exists({ _id: entityId, ...deletedOnlyFilter(Model) });

  if (!archived) {
    throw httpError(
      409,
      `This ${entry.label.toLowerCase()} is still active. Archive it first — permanent deletion only applies to already-archived records.`,
    );
  }
};

// ── Impact report ─────────────────────────────────────────────────────────────

/**
 * Counts, for every declared relation, how many documents it matches right now.
 *
 * Counts run in parallel: the report is a point-in-time snapshot, and its digest is what the
 * ticket binds to — any drift between preview and execute invalidates the ticket rather than
 * being papered over here.
 *
 * @param {import('./hard-delete.registry').HardDeleteEntry} entry
 * @param {string} entityId
 * @returns {Promise<Array<{ model, label, mode, count }>>}
 */
const computeImpact = async (entry, entityId, { session = null } = {}) => {
  const id = new mongoose.Types.ObjectId(String(entityId));

  return Promise.all(
    entry.relations.map(async (relation) => {
      const RelatedModel = resolveRelationModel(relation);

      // Counts are capped: the impact report runs one scan per relation, over collections
      // that hold millions of rows in a mature tenant, and no decision changes between
      // "10 000" and "10 431". A capped count is also stable while rows keep arriving under
      // a long-lived preview, which keeps the ticket digest usable.
      const count = await RelatedModel.countDocuments(relation.filter(id), {
        limit: IMPACT_COUNT_LIMIT,
        ...(session ? { session } : {}),
      });

      return {
        model:  relation.model,
        label:  relation.label,
        mode:   relation.mode,
        count,
        capped: count >= IMPACT_COUNT_LIMIT,
      };
    }),
  );
};

/** Impact lines that forbid the deletion. */
const blockersOf = (impact) =>
  impact.filter((line) => line.mode === RELATION_MODE.BLOCK && line.count > 0);

/**
 * Total number of documents the cascades would remove.
 *
 * Cascades run inside a single MongoDB transaction, bounded by the 16 MB oplog entry and the
 * 60-second default lifetime. Past a few thousand documents the transaction aborts mid-flight
 * and the operator gets an opaque 500 after a long hang, so the volume is checked up front.
 *
 * @param {Array<{ mode: string, count: number }>} impact
 * @returns {number}
 */
const cascadeVolumeOf = (impact) =>
  impact
    .filter((line) => line.mode === RELATION_MODE.CASCADE)
    .reduce((total, line) => total + line.count, 0);

/**
 * Strips credentials and internals from a document before it is frozen into the audit ledger.
 *
 * @param {Object} doc
 * @param {string[]} [redact]
 * @returns {Object}
 */
const buildSnapshot = (doc, redact = []) => {
  const snapshot = { ...doc };
  for (const field of ['password', 'passwordResetToken', 'passwordResetExpires', '__v', ...redact]) {
    delete snapshot[field];
  }
  return snapshot;
};

// ── Identity ──────────────────────────────────────────────────────────────────

/**
 * The business key the operator has to retype, resolved in ONE place.
 *
 * The registry's `identifier()` is free to return an empty string — `doc.matricule ||
 * doc.username` does exactly that when neither field is set — and `??` would let it through,
 * because `''` is neither null nor undefined. Two things break at once when it does: the
 * confirmation phrase collapses to a bare `DELETE`, which any operator can type by accident,
 * and `entityIdentifier` (required) fails validation on the audit write, aborting the whole
 * transaction. Falling back on the id keeps both the control and the ledger meaningful.
 *
 * @param {import('./hard-delete.registry').HardDeleteEntry} entry
 * @param {Object} target
 * @returns {string}
 */
const resolveIdentifier = (entry, target) => {
  const raw = String(entry.identifier(target) ?? '').trim();
  return raw || String(target._id);
};

/**
 * The human label, same reasoning as {@link resolveIdentifier}.
 *
 * @param {import('./hard-delete.registry').HardDeleteEntry} entry
 * @param {Object} target
 * @param {string} identifier - Fallback when the entity has no display name.
 * @returns {string}
 */
const resolveLabel = (entry, target, identifier) => {
  const raw = String(entry.display(target) ?? '').trim();
  return raw || identifier;
};

// ── Audit ─────────────────────────────────────────────────────────────────────

/**
 * Builds the DeletionAudit payload shared by the three write sites (refusal, generic removal,
 * document removal). One builder, so a field can never be present on the success row and
 * missing on the refusal row — the two are read side by side in the ledger.
 *
 * Free-text fields are truncated to their schema caps rather than left to Mongoose. A rejected
 * audit write is not a recoverable error here: on the success path it aborts the transaction
 * and makes the entity permanently undeletable, and on the refusal path the row is simply
 * lost. `Blocked by: …` over the `campus` entry's thirty-odd BLOCK relations overruns
 * `failureReason` on its own.
 *
 * @param {Object} params
 * @returns {Object} A `DeletionAudit` document payload.
 */
const buildAuditPayload = ({
  entry, entityType, target, req, reason, phrase, digest, impact,
  outcome, failureReason = null, passwordVerified = false, extra = {},
}) => {
  const identifier = resolveIdentifier(entry, target);

  return {
    entityType,
    entityModel:      entry.model().modelName,
    entityId:         target._id,
    entityIdentifier: truncateForAudit(identifier, AUDIT_FIELD_LIMITS.entityIdentifier),
    entityLabel:      truncateForAudit(resolveLabel(entry, target, identifier), AUDIT_FIELD_LIMITS.entityLabel),
    campusId:         entry.campusPath ? target[entry.campusPath] ?? null : null,
    performedBy:      req.user.id,
    performedByModel: req.user.role === 'CAMPUS_MANAGER' ? 'Campus' : 'Admin',
    performedByRole:  req.user.role,
    performedAt:      new Date(),
    reason:             truncateForAudit(reason, AUDIT_FIELD_LIMITS.reason),
    confirmationPhrase: truncateForAudit(phrase, AUDIT_FIELD_LIMITS.confirmationPhrase),
    impactDigest:       digest || 'n/a',
    passwordVerified:   Boolean(passwordVerified),
    outcome,
    failureReason:    failureReason ? truncateForAudit(failureReason, AUDIT_FIELD_LIMITS.failureReason) : null,
    impact:           (impact ?? []).filter((line) => line.count > 0),
    ipAddress:        req.ip ?? null,
    userAgent:        req.headers?.['user-agent'] ?? null,
    ...extra,
  };
};

// ── Preview ───────────────────────────────────────────────────────────────────

/**
 * Read-only impact report. Nothing is written; nothing is deleted.
 *
 * @param {Object} params
 * @param {string} params.entityType
 * @param {string} params.entityId
 * @param {import('express').Request} params.req
 * @returns {Promise<Object>} The report handed to the danger-zone dialog.
 */
const preview = async ({ entityType, entityId, req }) => {
  const entry  = resolveEntry(entityType, req.user);
  const target = await loadTarget(entry, entityId, req.user);

  await assertAlreadySoftDeleted(entry, entityId);

  const impact   = await computeImpact(entry, entityId);
  const blockers = blockersOf(impact);
  const digest   = digestImpact(impact);

  const identifier = resolveIdentifier(entry, target);

  // Surfaced at preview time, not only at execution: an operator who is going to be refused
  // should learn it before typing a confirmation phrase and their password.
  const cascadeVolume = cascadeVolumeOf(impact);
  const overCascadeLimit = cascadeVolume > MAX_CASCADE_DOCUMENTS;

  const deletable = blockers.length === 0 && !overCascadeLimit;

  // A ticket is only minted for an operation that could actually go through. Handing one out
  // for a blocked deletion would let the frontend queue a request that is guaranteed to fail.
  const ticket = deletable
    ? issueTicket({ actorId: req.user.id, entityType, entityId, impactDigest: digest })
    : null;

  return {
    entityType,
    entity: {
      id:         String(target._id),
      identifier,
      label:      resolveLabel(entry, target, identifier),
      campusId:   entry.campusPath ? target[entry.campusPath] ?? null : null,
    },
    confirmationPhrase: buildConfirmationPhrase(identifier),
    impact:   impact.filter((line) => line.count > 0),
    blockers,
    deletable,
    cascade: {
      total:        cascadeVolume,
      limit:        MAX_CASCADE_DOCUMENTS,
      overLimit:    overCascadeLimit,
    },
    // The dialog validates the reason before submitting, so it needs the bound the server
    // will apply — carried here rather than mirrored as a frontend literal (CLAUDE.md §0.1).
    requirements: {
      confirmationPhrase: true,
      password:           true,
      reason:             true,
      minReasonLength:    MIN_REASON_LENGTH,
      maxReasonLength:    MAX_REASON_LENGTH,
    },
    ticket:    ticket?.ticket ?? null,
    expiresAt: ticket?.expiresAt ?? null,
  };
};

// ── Execution ─────────────────────────────────────────────────────────────────

/**
 * Records an attempt that did not delete anything.
 *
 * Every refusal is a security-relevant event, not just the ones caused by protected records:
 * a wrong password, a phrase that does not match, a forged or replayed ticket and a
 * transaction that aborted all tell a reviewer that someone tried, when, and against what.
 * Writing only the BLOCKED ones would leave the most interesting attempts invisible.
 *
 * Never throws: an audit write that fails must not turn a clean refusal into a 500 whose
 * message no longer explains what the operator did wrong.
 *
 * @param {Object} params
 * @param {string} params.outcome - DELETION_OUTCOME.BLOCKED or .FAILED
 * @returns {Promise<void>}
 */
const auditRefusal = async ({
  entry, entityType, target, req, reason, phrase, digest, impact,
  failureReason, passwordVerified, outcome = DELETION_OUTCOME.BLOCKED,
}) => {
  try {
    await DeletionAudit.create(buildAuditPayload({
      entry, entityType, target, req, digest, impact,
      // The justification is only validated on the happy path; an attempt refused before that
      // still needs a non-empty required field, and the placeholder is itself informative.
      reason: reason || '(refused before a justification was accepted)',
      phrase: phrase || '(not verified)',
      outcome,
      failureReason,
      passwordVerified,
    }));
  } catch (err) {
    console.error('⚠️ hard-delete: failed to write the refusal audit entry:', err.message);
  }
};

/**
 * Applies cascades and detaches, then removes the target — all inside one transaction.
 *
 * @param {Object} params
 * @returns {Promise<{ cascadeDeleted: Object, detached: Object, auditId: string }>}
 */
const runTransactionalDelete = async ({ entry, entityType, target, req, reason, phrase, digest, impact }) => {
  const Model   = entry.model();
  const id      = new mongoose.Types.ObjectId(String(target._id));
  const session = await mongoose.startSession();

  const cascadeDeleted = {};
  const detached       = {};

  try {
    let auditId;

    await session.withTransaction(async () => {
      // Reset the accumulators: withTransaction may replay the callback on a transient error.
      for (const key of Object.keys(cascadeDeleted)) delete cascadeDeleted[key];
      for (const key of Object.keys(detached)) delete detached[key];

      // Blockers are re-counted INSIDE the transaction, not just at the gate. The gate reads
      // the database before the transaction opens, so a result published or a payment
      // recorded in that window would otherwise be orphaned by a deletion the operator was
      // told was safe. Re-reading under the transaction's snapshot closes that race.
      const liveImpact   = await computeImpact(entry, target._id, { session });
      const liveBlockers = blockersOf(liveImpact);
      if (liveBlockers.length > 0) {
        throw httpError(
          409,
          'Permanent deletion refused: protected records were created while the deletion was being confirmed',
          { blockers: liveBlockers },
        );
      }

      // The volume is re-read for the same reason the blockers are: rows added between the
      // gate and the commit would otherwise push the cascade past what one transaction can
      // carry, and the operator would get an opaque abort instead of the explicit refusal the
      // gate already knows how to phrase.
      const liveCascadeVolume = cascadeVolumeOf(liveImpact);
      if (liveCascadeVolume > MAX_CASCADE_DOCUMENTS) {
        throw httpError(
          409,
          `Permanent deletion refused: the cascade grew to ${liveCascadeVolume} documents while ` +
          `the deletion was being confirmed, above the ${MAX_CASCADE_DOCUMENTS} a single ` +
          `transaction can carry.`,
        );
      }

      for (const relation of entry.relations) {
        const RelatedModel = resolveRelationModel(relation);

        if (relation.mode === RELATION_MODE.CASCADE) {
          const res = await RelatedModel.deleteMany(relation.filter(id), { session });
          cascadeDeleted[relation.model] = (cascadeDeleted[relation.model] ?? 0) + (res.deletedCount ?? 0);
        }

        if (relation.mode === RELATION_MODE.DETACH) {
          const res = await RelatedModel.updateMany(relation.filter(id), relation.update(id), { session });
          detached[relation.model] = (detached[relation.model] ?? 0) + (res.modifiedCount ?? 0);
        }
      }

      const removed = await Model.deleteOne({ _id: id }, { session });
      if (removed.deletedCount !== 1) {
        throw httpError(409, `${entry.label} was already removed by another operation`);
      }

      const [audit] = await DeletionAudit.create([buildAuditPayload({
        entry, entityType, target, req, reason, phrase, digest, impact,
        outcome:          DELETION_OUTCOME.COMPLETED,
        passwordVerified: true,
        extra: {
          cascadeDeleted: { ...cascadeDeleted },
          detached:       { ...detached },
          snapshot:       buildSnapshot(target, entry.redact),
        },
      })], { session });

      auditId = audit._id;
    });

    return { cascadeDeleted, detached, auditId };

  } finally {
    await session.endSession();
  }
};

/**
 * Removes the stored files owned by the deleted document.
 *
 * Runs *after* the commit and never throws: a leftover file on disk is a cleanup task, while
 * rolling back a committed deletion is impossible. Failures are logged, not propagated.
 *
 * @param {import('./hard-delete.registry').HardDeleteEntry} entry
 * @param {Object} target
 * @returns {Promise<string[]>} Paths actually removed.
 */
const removeFiles = async (entry, target) => {
  if (typeof entry.files !== 'function') return [];

  const removed = [];

  for (const file of entry.files(target)) {
    if (!file?.path) continue;
    try {
      const ok = await deleteFile(file.folder, file.path);
      if (ok) removed.push(`${file.folder}/${file.path}`);
    } catch (err) {
      console.error(`⚠️ hard-delete: failed to remove file ${file.folder}/${file.path}:`, err.message);
    }
  }

  return removed;
};

/**
 * Performs a permanent deletion after clearing every control.
 *
 * @param {Object} params
 * @param {string} params.entityType
 * @param {string} params.entityId
 * @param {import('express').Request} params.req
 * @param {Object} params.confirmation - `{ ticket, confirmationPhrase, password, reason }`
 * @returns {Promise<Object>} Deletion receipt (audit id + what was removed).
 */
const execute = async ({ entityType, entityId, req, confirmation = {} }) => {
  const entry = resolveEntry(entityType, req.user);

  // ── Payload checks that need no database round-trip ───────────────────────
  // Run first so a malformed request is rejected before it costs a query, and so the
  // "missing field" errors are the same whether or not the target exists.
  const reasonCheck = verifyReason(confirmation.reason);
  if (!reasonCheck.valid) throw httpError(400, reasonCheck.error);

  if (!confirmation.confirmationPhrase) {
    throw httpError(400, 'The confirmation phrase is required');
  }
  if (!confirmation.password) {
    throw httpError(400, 'Your password is required to confirm a permanent deletion');
  }
  if (!confirmation.ticket) {
    throw httpError(400, 'A deletion ticket from the impact preview is required');
  }

  const target = await loadTarget(entry, entityId, req.user);

  await assertAlreadySoftDeleted(entry, entityId);

  const identifier = resolveIdentifier(entry, target);

  const impact = await computeImpact(entry, entityId);
  const digest = digestImpact(impact);

  /**
   * Records the refusal, then throws. Every exit below the "target loaded" line goes through
   * here, so no attempt against a real entity leaves the ledger empty.
   *
   * @param {number} status
   * @param {string} message
   * @param {Object} [opts] - `{ failureReason, passwordVerified, phrase, extra }`
   */
  const refuse = async (status, message, opts = {}) => {
    await auditRefusal({
      entry, entityType, target, req,
      reason:  reasonCheck.value,
      phrase:  opts.phrase ?? '(not verified)',
      digest, impact,
      failureReason:    opts.failureReason ?? message,
      passwordVerified: opts.passwordVerified ?? false,
      outcome:          opts.outcome ?? DELETION_OUTCOME.FAILED,
    });

    throw httpError(status, message, opts.extra ?? {});
  };

  const phraseCheck = verifyConfirmationPhrase(confirmation.confirmationPhrase, identifier);
  if (!phraseCheck.valid) {
    await refuse(400, `Confirmation phrase mismatch. Type exactly: ${phraseCheck.expected}`, {
      failureReason: 'Confirmation phrase did not match the target identifier',
    });
  }

  // ── Ticket: proves this exact impact report was reviewed ──────────────────
  const ticketCheck = verifyTicket(confirmation.ticket, {
    actorId: req.user.id,
    entityType,
    entityId,
    impactDigest: digest,
  });
  if (!ticketCheck.valid) {
    await refuse(409, ticketCheck.error, {
      phrase:        phraseCheck.expected,
      failureReason: `Ticket rejected: ${ticketCheck.error}`,
    });
  }

  // ── Re-authentication ─────────────────────────────────────────────────────
  const passwordCheck = await verifyActorPassword(req.user, confirmation.password);
  if (!passwordCheck.valid) {
    await refuse(401, passwordCheck.error, {
      phrase:        phraseCheck.expected,
      failureReason: `Re-authentication failed: ${passwordCheck.error}`,
    });
  }

  // ── Blockers ──────────────────────────────────────────────────────────────
  const blockers = blockersOf(impact);
  if (blockers.length > 0) {
    await refuse(409, 'Permanent deletion refused: protected records still reference this entity', {
      phrase:           phraseCheck.expected,
      passwordVerified: true,
      outcome:          DELETION_OUTCOME.BLOCKED,
      failureReason:    `Blocked by: ${blockers.map((b) => `${b.label} (${b.count})`).join(', ')}`,
      extra:            { blockers },
    });
  }

  // ── Cascade volume ────────────────────────────────────────────────────────
  const cascadeVolume = cascadeVolumeOf(impact);
  if (cascadeVolume > MAX_CASCADE_DOCUMENTS) {
    await refuse(
      409,
      `This deletion would cascade ${cascadeVolume >= IMPACT_COUNT_LIMIT ? `over ${IMPACT_COUNT_LIMIT}` : cascadeVolume} documents, ` +
      `above the ${MAX_CASCADE_DOCUMENTS} a single transaction can carry. Purge the derived records first, then retry.`,
      {
        phrase:           phraseCheck.expected,
        passwordVerified: true,
        failureReason:    `Cascade volume ${cascadeVolume} exceeds the ${MAX_CASCADE_DOCUMENTS} limit`,
      },
    );
  }

  // ── Removal ───────────────────────────────────────────────────────────────
  const removalArgs = {
    entry, entityType, target, req,
    reason: reasonCheck.value,
    phrase: phraseCheck.expected,
    digest, impact,
  };

  let cascadeDeleted; let detached; let auditId;
  try {
    if (entry.customExecutor === 'document') {
      return await executeDocumentDelete(removalArgs);
    }
    ({ cascadeDeleted, detached, auditId } = await runTransactionalDelete(removalArgs));
  } catch (err) {
    // The transaction rolled back — nothing was deleted, but the attempt happened.
    await auditRefusal({
      ...removalArgs,
      failureReason:    `Execution aborted: ${err.message}`,
      passwordVerified: true,
      outcome:          err.blockers ? DELETION_OUTCOME.BLOCKED : DELETION_OUTCOME.FAILED,
    });
    throw err;
  }

  const filesRemoved = await removeFiles(entry, target);
  if (filesRemoved.length > 0) {
    await DeletionAudit.updateOne({ _id: auditId }, { $set: { filesRemoved } });
  }

  return {
    auditId:    String(auditId),
    entityType,
    entityId:   String(target._id),
    identifier,
    label:      resolveLabel(entry, target, identifier),
    cascadeDeleted,
    detached,
    filesRemoved,
  };
};

/**
 * Delegates the removal to the GED, which owns a richer teardown (version purge, storage-cache
 * invalidation, DocumentAudit entry, ai-service re-ingest signal) than the generic executor.
 *
 * The gate has already run; only the removal differs. The DeletionAudit row is still written
 * here so the platform-wide ledger stays complete — the document module's own audit trail is
 * scoped to documents and answers a different question.
 *
 * The stored files the GED purges are reported back and recorded on the ledger row, exactly as
 * `removeFiles()` does for the generic path: `filesRemoved: []` on a document deletion would
 * read as "nothing was on disk", which is the opposite of what happens.
 *
 * @param {Object} params
 * @returns {Promise<Object>} Deletion receipt.
 */
const executeDocumentDelete = async ({ entry, entityType, target, req, reason, phrase, digest, impact }) => {
  const documentService = require('../../../modules/document/services/document.service');

  const { filesRemoved = [] } = await documentService.hardDeleteDocument(String(target._id), req) ?? {};

  const identifier = resolveIdentifier(entry, target);

  const audit = await DeletionAudit.create(buildAuditPayload({
    entry, entityType, target, req, reason, phrase, digest, impact,
    outcome:          DELETION_OUTCOME.COMPLETED,
    passwordVerified: true,
    extra: {
      snapshot: buildSnapshot(target, entry.redact),
      filesRemoved,
    },
  }));

  return {
    auditId:  String(audit._id),
    entityType,
    entityId: String(target._id),
    identifier,
    label:    resolveLabel(entry, target, identifier),
    cascadeDeleted: {},
    detached:       {},
    filesRemoved,
  };
};

// ── History ───────────────────────────────────────────────────────────────────

/**
 * Paginated read of the deletion ledger, campus-scoped for non-global roles.
 *
 * @param {Object} params
 * @param {import('express').Request} params.req
 * @param {Object} params.query - `{ entityType, outcome, page, limit }`
 * @returns {Promise<{ entries: Object[], total: number, page: number, limit: number }>}
 */
const listHistory = async ({ req, query = {} }) => {
  const page  = Math.max(Number(query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100);

  const filter = {};

  if (!GLOBAL_ROLES.includes(req.user.role)) {
    if (!req.user.campusId) throw httpError(403, 'Campus isolation breach prevented: no campusId on your account');
    filter.campusId = req.user.campusId;
  } else if (query.campusId && isValidObjectId(query.campusId)) {
    filter.campusId = query.campusId;
  }

  if (query.entityType) filter.entityType = query.entityType;
  if (query.outcome)    filter.outcome    = query.outcome;

  const [entries, total] = await Promise.all([
    DeletionAudit.find(filter)
      .select('-snapshot')
      .sort({ performedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    DeletionAudit.countDocuments(filter),
  ]);

  return { entries, total, page, limit };
};

module.exports = {
  preview,
  execute,
  listHistory,
  // Exported for tests and for the per-module controllers that delegate here.
  computeImpact,
  blockersOf,
  cascadeVolumeOf,
  resolveEntry,
};
