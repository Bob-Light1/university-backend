'use strict';

/** @file announcement.mutation.service.js @description Transactional announcement workflow and post-publication audit emission. */
const repository = require('./announcement.repository');
const { service: audit, constants: { ACTION, ACTOR, SCOPE } } = require('../audit');
const { source, isEligible, project } = require('./announcement.audit');
const { STATUS, EDITABLE_FIELDS, OPERATION, SWEEP_PAGE_SIZE } = require('./announcement.constants');
const { softDeletePatch } = require('../../shared/utils/soft-delete');

/** Preserve existing HTTP validation semantics for workflow refusals. */
function refuse(message) {
  throw Object.assign(new Error(message), { statusCode: 400 });
}

const { futureDateError } = require('./announcement.validation');

/** Refuse an invalid optional date using the shared HTTP contract. */
function futureDate(value, label, now) {
  const message = futureDateError(value, label, now);
  if (message) refuse(message);
}

/** Compute allowed changes against current transactional state, never a prior HTTP read. */
function fieldsFor(doc, operation, input, now) {
  switch (operation) {
    case OPERATION.UPDATE: {
      if (doc.status === STATUS.PUBLISHED) refuse('Published announcements cannot be edited. Archive it first.');
      const fields = Object.fromEntries(EDITABLE_FIELDS.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
      if (fields.expiresAt) futureDate(fields.expiresAt, 'expiry date', now);
      if ((fields.pinned !== undefined ? fields.pinned : doc.pinned) && fields.pinnedUntil) {
        futureDate(fields.pinnedUntil, 'auto-unpin date', now);
      }
      return fields;
    }
    case OPERATION.PUBLISH:
      if (doc.status === STATUS.PUBLISHED) refuse('Announcement is already published.');
      if (doc.expiresAt && doc.expiresAt <= now) refuse('Announcement has already expired. Update or clear expiresAt before publishing.');
      return { status: STATUS.PUBLISHED, publishedAt: now, archivedAt: null };
    case OPERATION.ARCHIVE:
      if (doc.status === STATUS.ARCHIVED) refuse('Announcement is already archived.');
      return { status: STATUS.ARCHIVED, archivedAt: now };
    case OPERATION.PIN: {
      const pinned = !doc.pinned;
      const fields = { pinned };
      if (!pinned) fields.pinnedUntil = null;
      else if (input.pinnedUntil !== undefined && input.pinnedUntil !== null) {
        futureDate(input.pinnedUntil, 'auto-unpin date', now);
        fields.pinnedUntil = input.pinnedUntil;
      }
      return fields;
    }
    case OPERATION.DELETE: return softDeletePatch(doc.constructor, { at: now });
    case OPERATION.EXPIRE: return { status: STATUS.ARCHIVED, archivedAt: now };
    case OPERATION.UNPIN: return { pinned: false, pinnedUntil: null };
    default: throw new Error('Unknown announcement mutation operation.');
  }
}

/** Map a backend-owned operation to the shared action vocabulary. */
function actionFor(operation) {
  if ([OPERATION.ARCHIVE, OPERATION.EXPIRE, OPERATION.DELETE].includes(operation)) return ACTION.ARCHIVE;
  return operation === OPERATION.PUBLISH ? ACTION.TRANSITION : ACTION.UPDATE;
}

/**
 * Couple a scoped business mutation and event. The cached handle belongs to this
 * invocation and survives automatic transaction retries; before-state is re-read.
 */
async function mutate({ id, user, operation, input = {}, now = new Date(), system = false }) {
  let mutation;
  return repository.withTransaction(async session => {
    const doc = system ? await repository.loadDue(id, operation, now, session)
      : await repository.loadForMutation({ id, user }, session);
    if (!doc) return null;
    const before = doc.toObject();
    const eligible = isEligible(before);
    const fields = fieldsFor(doc, operation, input, now);
    Object.assign(doc, fields);
    doc.auditEligible = eligible || isEligible(doc);
    const after = await repository.saveMutation(doc, session);
    if (eligible) {
      mutation ||= audit.createMutation(source, {
        entityId: before._id, scope: SCOPE.CAMPUS, schoolCampus: before.schoolCampus,
        operation, action: actionFor(operation), actor: {
          kind: system ? ACTOR.SYSTEM : ACTOR.USER,
          id: system ? null : user.id, role: system ? null : user.role, source: operation,
        },
      });
      await audit.appendMutation(mutation, { before: project(before), after: project(after), session });
    }
    return after;
  });
}

/** Update only editable fields; workflow checks run inside the transaction. */
const updateAnnouncement = (id, user, input) => mutate({ id, user, input, operation: OPERATION.UPDATE });
/** First publication establishes eligibility; republication is a tracked transition. */
const publishAnnouncement = (id, user) => mutate({ id, user, operation: OPERATION.PUBLISH });
/** Archive without erasing publication eligibility. */
const archiveAnnouncement = (id, user) => mutate({ id, user, operation: OPERATION.ARCHIVE });
/** Toggle the persisted pin state, including on currently published announcements. */
const togglePin = (id, user, input) => mutate({ id, user, input, operation: OPERATION.PIN });
/** Soft deletion uses the model's derived deletion convention. */
const deleteAnnouncement = (id, user) => mutate({ id, user, operation: OPERATION.DELETE });

/** Bounded discovery with per-row transactions; errors report already committed work. */
async function sweep(operation, now) {
  let committedCount = 0;
  let afterId;
  try {
    for (;;) {
      const candidates = await repository.listDue(operation, now, { afterId, limit: SWEEP_PAGE_SIZE });
      if (!candidates.length) return committedCount;
      for (const { _id } of candidates) {
        if (await mutate({ id: _id, operation, now, system: true })) committedCount += 1;
      }
      afterId = candidates[candidates.length - 1]._id;
    }
  } catch (error) {
    error.committedCount = committedCount;
    error.operation = operation;
    throw error;
  }
}

/** Archive expired published announcements, rechecking eligibility and expiry on each retry. */
const archiveExpired = (now) => sweep(OPERATION.EXPIRE, now);
/** Unpin due announcements while preserving draft-only exclusion. */
const unpinExpired = (now) => sweep(OPERATION.UNPIN, now);

module.exports = { updateAnnouncement, publishAnnouncement, archiveAnnouncement, togglePin,
  deleteAnnouncement, archiveExpired, unpinExpired };
