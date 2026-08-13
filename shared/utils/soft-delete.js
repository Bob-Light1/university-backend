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
 * Models whose convention CANNOT be inferred from the schema, because they carry a
 * lowercase 'archived' status enum *and* a `deletedAt` field that mean two different things.
 * Guessing here is exactly the silent failure this file exists to prevent, so the answer is
 * declared instead of derived.
 *
 *  - `Announcement`: 'archived' is a PUBLICATION state — an announcement is archived by the
 *    nightly expiry cron when `expiresAt` passes, and it is still a perfectly live record.
 *    The deletion marker is `deletedAt` (announcement.admin.controller.deleteAnnouncement).
 *    Reading it the other way round both hides expired announcements and resurrects deleted
 *    ones.
 *  - `Course`: the reverse — `archiveCourse()` writes `status: 'archived'` AND `deletedAt`
 *    together, and `restoreCourse()` clears both. `status` is the marker; `deletedAt` is the
 *    timestamp companion.
 *
 * Any other model carrying both markers throws until it is declared here (see
 * {@link detectStrategy}).
 */
const STRATEGY_OVERRIDES = Object.freeze({
  Announcement: 'deletedAt',
  Course:       'status',
});

/**
 * Detects which soft-delete convention a model follows.
 *
 * Precedence is deliberate and load-bearing:
 *
 *  1. An explicit {@link STRATEGY_OVERRIDES} entry always wins.
 *  2. `isDeleted` is checked next because the record models (Result, exam, finance, schedules)
 *     carry BOTH an `isDeleted` boolean and a `status` enum whose values happen to include an
 *     uppercase 'ARCHIVED' — a workflow state, not a deletion. Testing `status` first would
 *     silently treat archived-but-live results as deleted, and vice versa.
 *  3. A lowercase 'archived' status enum means the actor / configuration convention…
 *  4. …and a bare `deletedAt` means the GED convention.
 *
 * When 3 and 4 are BOTH present the schema is genuinely ambiguous: only the module's own code
 * knows which field it writes. Rather than pick one and be silently wrong on half the queries,
 * this throws until the model is declared in {@link STRATEGY_OVERRIDES}.
 *
 * @param {import('mongoose').Model} Model
 * @returns {'isDeleted'|'status'|'deletedAt'|null}
 * @throws {Error} When the schema carries two conflicting markers and no override.
 */
const detectStrategy = (Model) => {
  const schema = Model?.schema;
  if (!schema) return null;

  const override = STRATEGY_OVERRIDES[Model.modelName];
  if (override) return override;

  if (schema.path('isDeleted')) return 'isDeleted';

  const statusPath = schema.path('status');
  const statusEnum = statusPath?.enumValues ?? statusPath?.options?.enum?.values ?? statusPath?.options?.enum;
  const hasArchivedStatus = Array.isArray(statusEnum) && statusEnum.includes(ARCHIVED_STATUS);
  const hasDeletedAt      = Boolean(schema.path('deletedAt'));

  if (hasArchivedStatus && hasDeletedAt) {
    throw new Error(
      `soft-delete: model '${Model.modelName}' carries BOTH an 'archived' status enum and a ` +
      `'deletedAt' field — the convention cannot be inferred. Declare it in STRATEGY_OVERRIDES ` +
      `in shared/utils/soft-delete.js after checking which field the module actually writes. ` +
      `See CLAUDE.md §5.1.`
    );
  }

  if (hasArchivedStatus) return 'status';

  // Document (GED): deletion is `deletedAt !== null`. There is no boolean, and its `status`
  // enum (DRAFT / PUBLISHED / LOCKED / …) is a workflow, not a deletion.
  if (hasDeletedAt) return 'deletedAt';

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
 * Builds the update patch that restores a soft-deleted document — the exact undo of
 * {@link softDeletePatch}.
 *
 * For the `status` convention there is no universal "restored" value: the pre-archive status
 * is not recorded anywhere, so the schema's own declared default is the only defensible
 * answer, and a schema that declares none throws rather than being handed a guess. The
 * companion fields (`deletedAt`, `deletedBy`) are cleared whenever the schema carries them,
 * so a restored document is not left holding the timestamp of a deletion that no longer
 * applies.
 *
 * @param {import('mongoose').Model} Model
 * @returns {Object} A `$set`-able patch.
 * @throws {Error} If the model is not soft-deletable, or follows the `status` convention
 *                 without declaring a default status.
 */
const restorePatch = (Model) => {
  const strategy = resolveStrategy(Model, 'restorePatch');
  const patch = {};

  if (strategy === 'isDeleted') patch.isDeleted = false;

  if (strategy === 'status') {
    const fallback = Model.schema.path('status')?.options?.default;

    if (typeof fallback !== 'string' || fallback === ARCHIVED_STATUS) {
      throw new Error(
        `restorePatch: model '${Model.modelName}' follows the 'status' convention but declares ` +
        `no usable default status to restore to. Add a default to the schema, or restore it ` +
        `explicitly in the module that owns the transition. See CLAUDE.md §5.1.`
      );
    }

    patch.status = fallback;
  }

  if (Model.schema.path('deletedAt')) patch.deletedAt = null;
  if (Model.schema.path('deletedBy')) patch.deletedBy = null;

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
  restorePatch,
  isSoftDeletable,
};
