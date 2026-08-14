'use strict';

/**
 * @file unique-scope.js
 * @description Derives the SCOPE of a field's uniqueness constraint from the model itself.
 *
 * Uniqueness is not a global property in this codebase, and which form a model uses is not
 * visible from the calling site:
 *
 *   Teacher — `teacherSchema.index({ schoolCampus: 1, email: 1 }, { unique: true })`
 *             two teachers in two campuses may share an email.
 *   Student — `email: { type: String, unique: true }`
 *             one email across the whole platform.
 *
 * A duplicate check that assumes the global form on a per-campus index rejects legitimate
 * rows — an import into campus B refused because campus A already employs that address,
 * reported to the operator as "already exists" with no mention of a campus. The symmetric
 * mistake, assuming the scoped form on a global index, lets real duplicates through and is
 * caught by the database. So this reads the schema instead of assuming either.
 *
 * Same principle as `shared/utils/soft-delete.js`: the model owns its convention, the
 * caller derives it.
 */

/**
 * Determines whether a field's uniqueness is global or scoped, and by which keys.
 *
 * BOTH declaration forms must be consulted. Checking only `schema.indexes()` is what makes
 * a reader conclude that `Student.email` carries no unique constraint at all:
 *
 *   1. `schema.index({ a: 1, b: 1 }, { unique: true })` — appears in `schema.indexes()`;
 *      the other keys of that index ARE the scope.
 *   2. `{ email: { type: String, unique: true } }` — never appears in `schema.indexes()`;
 *      it lives on the path options.
 *
 * @param {import('mongoose').Model} Model
 * @param {string} field - The field a duplicate is being looked up on
 * @returns {{ scoped: boolean, scopeKeys: string[] }}
 *          `scoped: false` → uniqueness is global; query the field alone.
 *          `scoped: true`  → uniqueness holds per `scopeKeys`; the query must carry them.
 */
const uniqueScopeFor = (Model, field) => {
  const schema = Model?.schema;
  if (!schema) return { scoped: false, scopeKeys: [] };

  // 1 — compound unique indexes declared via schema.index()
  for (const [fields, options] of schema.indexes()) {
    if (!options || options.unique !== true) continue;

    const keys = Object.keys(fields);
    if (!keys.includes(field)) continue;

    const scopeKeys = keys.filter((key) => key !== field);
    // A single-key unique index is a global constraint, same as the path form.
    return { scoped: scopeKeys.length > 0, scopeKeys };
  }

  // 2 — field-level `unique: true`
  if (schema.path(field)?.options?.unique === true) {
    return { scoped: false, scopeKeys: [] };
  }

  // 3 — no declared unique constraint. Fail CLOSED, i.e. keep the strict global check:
  //     widening it here would let genuine duplicates through, which is worse than the
  //     false rejection this helper exists to remove.
  return { scoped: false, scopeKeys: [] };
};

/**
 * Builds the duplicate-lookup query for one field, carrying the scope its index declares.
 *
 * A scope key that cannot be filled is LEFT OUT rather than queried as `undefined`:
 * `{ email, schoolCampus: undefined }` matches on email alone in Mongo, which would turn a
 * scoped check back into a global one at the exact moment the caller lost the campus.
 * Omitting it keeps the query strict — a false rejection, never a missed duplicate.
 *
 * @param {import('mongoose').Model} Model
 * @param {string} field
 * @param {*} value - Already normalized by the caller (e.g. email lowercased)
 * @param {Object} [scopeValues] - Available scope values, e.g. { schoolCampus: campusId }
 * @returns {{ query: Object, scoped: boolean }}
 */
const buildUniquenessQuery = (Model, field, value, scopeValues = {}) => {
  const query = { [field]: value };
  const { scoped, scopeKeys } = uniqueScopeFor(Model, field);

  if (!scoped) return { query, scoped: false };

  let applied = 0;
  for (const key of scopeKeys) {
    if (scopeValues[key] === undefined || scopeValues[key] === null) continue;
    query[key] = scopeValues[key];
    applied += 1;
  }

  return { query, scoped: applied === scopeKeys.length };
};

module.exports = { uniqueScopeFor, buildUniquenessQuery };
