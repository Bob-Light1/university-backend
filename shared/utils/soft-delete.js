'use strict';

/**
 * @file soft-delete.js
 * @description Single entry point for soft-delete filters and patches.
 *
 * This codebase carries THREE soft-delete conventions, one per family of models
 * (see CLAUDE.md §5). They are all legitimate, but they are not interchangeable, and
 * hand-writing the wrong one fails SILENTLY:
 *
 *   - `{ isDeleted: false }` on `students` matches NOTHING (the field does not exist).
 *   - `{ status: { $ne: 'archived' } }` on `results` filters NO deletion at all
 *     (Result's status enum is a workflow state — PUBLISHED / ARCHIVED — not a deletion flag).
 *
 * Never hand-write a not-deleted filter. Derive it from the model:
 *
 *   const { notDeletedFilter } = require('shared/utils/soft-delete');
 *   const filter = { ...campusFilter, ...notDeletedFilter(Student) };
 *
 * A model with no soft-delete convention THROWS rather than returning `{}` — an empty
 * filter would silently include deleted documents, which is the failure this file exists
 * to prevent. Fail closed, like buildCampusFilter().
 */

/** Deletion marker used by the actor / configuration models (Student, Teacher, Class, …). */
const ARCHIVED_STATUS = 'archived';

/** Resolution cache, keyed by model name — schema introspection runs once per model. */
const strategyCache = new Map();

/**
 * Detects which soft-delete convention a model follows.
 *
 * Precedence is deliberate and load-bearing: `isDeleted` is checked FIRST because the
 * record models (Result, exam, finance) carry BOTH an `isDeleted` boolean and a `status`
 * enum whose values happen to include an uppercase 'ARCHIVED' — a workflow state, not a
 * deletion. Testing `status` first would silently treat archived-but-live results as
 * deleted, and vice versa.
 *
 * @param {import('mongoose').Model} Model
 * @returns {'isDeleted'|'status'|'deletedAt'|null}
 */
const detectStrategy = (Model) => {
  const schema = Model?.schema;
  if (!schema) return null;

  if (schema.path('isDeleted')) return 'isDeleted';

  const statusPath = schema.path('status');
  const statusEnum = statusPath?.enumValues ?? statusPath?.options?.enum?.values ?? statusPath?.options?.enum;
  if (Array.isArray(statusEnum) && statusEnum.includes(ARCHIVED_STATUS)) return 'status';

  // Document (GED): deletion is `deletedAt !== null`. There is no boolean, and its `status`
  // enum (DRAFT / PUBLISHED / LOCKED / …) is a workflow, not a deletion.
  if (schema.path('deletedAt')) return 'deletedAt';

  return null;
};

/**
 * Resolves — and caches — the soft-delete strategy of a model.
 *
 * @param {import('mongoose').Model} Model
 * @param {string} caller - Helper name, for the error message.
 * @returns {'isDeleted'|'status'|'deletedAt'}
 * @throws {Error} If the model has no soft-delete convention.
 */
const resolveStrategy = (Model, caller) => {
  const key = Model?.modelName;

  if (key && strategyCache.has(key)) return strategyCache.get(key);

  const strategy = detectStrategy(Model);

  if (!strategy) {
    throw new Error(
      `${caller}: model '${key ?? '<unknown>'}' has no soft-delete convention ` +
      `(no 'isDeleted', no 'archived' status enum, no 'deletedAt'). ` +
      `Either it is not soft-deletable — in which case do not call this helper — ` +
      `or its schema is missing a deletion marker. See CLAUDE.md §5.`
    );
  }

  if (key) strategyCache.set(key, strategy);
  return strategy;
};

/**
 * Builds the "not deleted" filter for a model, whichever convention it follows.
 *
 * @param {import('mongoose').Model} Model - The Mongoose model being queried.
 * @returns {Object} A filter fragment to spread into a query.
 * @throws {Error} If the model is not soft-deletable.
 *
 * @example
 *   Student.find({ ...campusFilter, ...notDeletedFilter(Student) });  // status: { $ne: 'archived' }
 *   Result.find({ ...campusFilter, ...notDeletedFilter(Result) });    // isDeleted: false
 *   Document.find({ ...campusFilter, ...notDeletedFilter(Document) });// deletedAt: null
 */
const notDeletedFilter = (Model) => {
  switch (resolveStrategy(Model, 'notDeletedFilter')) {
    case 'isDeleted': return { isDeleted: false };
    case 'status':    return { status: { $ne: ARCHIVED_STATUS } };
    case 'deletedAt': return { deletedAt: null };
    default:          throw new Error('notDeletedFilter: unreachable');
  }
};

/**
 * Builds the "only deleted" filter — the exact complement of {@link notDeletedFilter}.
 * For restore screens, purge crons and admin audits.
 *
 * @param {import('mongoose').Model} Model
 * @returns {Object} A filter fragment to spread into a query.
 * @throws {Error} If the model is not soft-deletable.
 */
const deletedOnlyFilter = (Model) => {
  switch (resolveStrategy(Model, 'deletedOnlyFilter')) {
    case 'isDeleted': return { isDeleted: true };
    case 'status':    return { status: ARCHIVED_STATUS };
    case 'deletedAt': return { deletedAt: { $ne: null } };
    default:          throw new Error('deletedOnlyFilter: unreachable');
  }
};

/**
 * Builds the update patch that soft-deletes a document — the write-side counterpart of
 * {@link notDeletedFilter}. Marking a deletion the wrong way is the symmetric bug to
 * filtering it the wrong way, and just as silent.
 *
 * `deletedAt` is stamped whenever the schema has the field, regardless of strategy: the
 * record models carry both `isDeleted` and `deletedAt`, and retention crons rely on the
 * timestamp.
 *
 * @param {import('mongoose').Model} Model
 * @param {Object}  [opts]
 * @param {Date}    [opts.at=new Date()] - Deletion timestamp.
 * @returns {Object} A `$set`-able patch.
 * @throws {Error} If the model is not soft-deletable.
 */
const softDeletePatch = (Model, { at = new Date() } = {}) => {
  const strategy = resolveStrategy(Model, 'softDeletePatch');
  const patch = {};

  if (strategy === 'isDeleted') patch.isDeleted = true;
  if (strategy === 'status')    patch.status    = ARCHIVED_STATUS;

  if (Model.schema.path('deletedAt')) patch.deletedAt = at;

  return patch;
};

/**
 * Whether a model carries any soft-delete convention. Use it to branch; use
 * {@link notDeletedFilter} to query.
 *
 * @param {import('mongoose').Model} Model
 * @returns {boolean}
 */
const isSoftDeletable = (Model) => detectStrategy(Model) !== null;

module.exports = {
  ARCHIVED_STATUS,
  notDeletedFilter,
  deletedOnlyFilter,
  softDeletePatch,
  isSoftDeletable,
};
