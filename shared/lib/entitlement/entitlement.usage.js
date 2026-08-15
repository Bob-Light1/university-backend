'use strict';

/**
 * @file entitlement.usage.js
 * @description The per-edge probes behind a toggle refusal — "is this module
 * actually in use on THIS campus?".
 *
 * Design doc §6.3.3: a HARD edge does not refuse a toggle on its own. The
 * registry declares that `result` structurally needs `subject`; only the DATA
 * decides. Hiding `subject` is legal on a campus with no timetable and no
 * result, and refused on a campus that has some. Without that rule `subject`,
 * `level` and `department` would become permanently undisableable by simple
 * transitive closure of the core — a button that can never be pressed.
 *
 * Same shape as `shared/lib/hard-delete/hard-delete.registry.js`, deliberately:
 * a declared model, a human label, a campus-scoped filter. Two probe families:
 *
 *  - {@link HARD_EDGES}   — for each feature, the models whose rows carry a
 *    `required` reference INTO it. Non-empty on this campus ⇒ 409 on HIDDEN.
 *  - the floor probe      — `FEATURE_REGISTRY[key].records`, the institutional
 *    records that make a module freezable but no longer hideable (§4.1.1).
 *
 * Both count with `.limit(1)`: the answer is a boolean, never a total, and this
 * only ever runs at toggle time — never in the request path.
 *
 * Model accessors are REUSED from the hard-delete registry rather than
 * re-declared (CLAUDE.md §0.1): it already owns the lazy `() => require(...)`
 * map for every model in the platform, and two copies would drift.
 */

const mongoose = require('mongoose');
const { MODEL_ACCESSORS } = require('../hard-delete/hard-delete.registry');
const { notDeletedFilter, isSoftDeletable } = require('../../utils/soft-delete');
const { FEATURE_REGISTRY, FEATURE_KEYS } = require('../../constants/features.constants');

/** The three campus field names in use across the schemas, most common first. */
const CAMPUS_PATHS = Object.freeze(['schoolCampus', 'campusId', 'campus']);

/**
 * Declares one structural edge: rows of `model` that cannot exist without the
 * feature being probed.
 *
 * @param {string} model - Key in `MODEL_ACCESSORS`.
 * @param {string} path  - The `required` reference path carrying the edge.
 * @param {string} label - Surfaced to the operator in the refusal.
 */
const edge = (model, path, label) => Object.freeze({ model, path, label });

/**
 * Models holding a `required` reference into each feature, derived from the
 * schemas on 2026-08-15 (the same extraction that produced the HARD graph of
 * §6.3.2). `tests/unit/entitlement-deps.test.js` pins every entry against the
 * real schema: a path that no longer exists would silently match nothing —
 * a blocker that never blocks.
 *
 * Core features carry no probe: they can never be toggled, so nothing would
 * ever read it. Features nothing depends on carry an empty list, declared
 * rather than omitted so the coverage test can tell "no dependants" from
 * "forgotten".
 */
const HARD_EDGES = Object.freeze({
  // ── Core — never toggled, never probed ──────────────────────────────────
  account: [], settings: [], campus: [], admin: [], notification: [],
  student: [], teacher: [], class: [], 'danger-zone': [],

  // ── Actually reachable refusals ─────────────────────────────────────────
  subject: [
    edge('Result',            'subject',   'Results'),
    edge('ExamSession',       'subject',   'Exam sessions'),
    edge('QuestionBank',      'subject',   'Question banks'),
    // Nested paths, both of them: the reference lives inside a sub-schema
    // (`courseRequirements[]`, `subject{}`) and NOT at the document root. A
    // filter on the root name would match nothing at all — a blocker that never
    // blocks — which is precisely what `tests/unit/entitlement-deps.test.js`
    // pins against the real schemas.
    edge('GaetConstraint',    'courseRequirements.subjectId', 'Timetable constraints'),
    edge('StudentSchedule',   'subject.subjectId',            'Student timetables'),
    edge('StudentAttendance', 'subject',   'Student attendance'),
    edge('TeacherAttendance', 'subject',   'Teacher attendance'),
  ],
  level: [
    // `Course.level` is a HARD edge too, but Course is a GLOBAL collection with
    // no campus field: counting it would refuse the toggle on every campus of
    // the platform because of one course created elsewhere. A global collection
    // cannot justify a per-campus refusal — it is reported as an impact
    // warning instead (§6.3.1, soft edges never refuse).
    edge('Class', 'level', 'Classes'),
  ],
  department: [
    edge('Teacher', 'department', 'Teachers'),
  ],

  // ── Terminal consumers: nothing structurally depends on them ────────────
  result: [], exam: [], finance: [], document: [], course: [], parent: [],
  announcement: [], 'academic-print': [], mentor: [], staff: [],
  'public-portal': [], gaet: [], partner: [], ai: [],
});

/**
 * The campus field of a model, read from the schema rather than declared.
 * Three names coexist in the codebase (`schoolCampus`, `campusId`, `campus`);
 * hard-coding the wrong one produces a filter Mongo happily ignores, i.e. a
 * count over the whole platform.
 *
 * @param {import('mongoose').Model} Model
 * @returns {string|null} null for a global (non campus-scoped) collection.
 */
const resolveCampusPath = (Model) =>
  CAMPUS_PATHS.find((path) => Model?.schema?.path(path)) || null;

/**
 * Resolves a model by its `MODEL_ACCESSORS` key, falling back to the mongoose
 * registry (a model declared by a module nobody required yet).
 *
 * @param {string} name
 * @returns {import('mongoose').Model}
 * @throws {Error} when the name resolves to nothing — fail closed HERE: an
 *   unresolvable probe would report "not in use" and let a refusal through.
 */
const resolveModel = (name) => {
  const accessor = MODEL_ACCESSORS[name];
  const Model = accessor ? accessor() : mongoose.models[name];
  if (!Model?.schema) {
    throw new Error(`entitlement.usage: unknown model '${name}' — check the probe declaration`);
  }
  return Model;
};

/**
 * Whether at least one document matches, scoped to the campus and excluding
 * soft-deleted rows. Bounded to a single document: this answers a yes/no.
 *
 * @param {string} modelName
 * @param {string} campusId
 * @param {Object} [extraFilter]
 * @returns {Promise<boolean>}
 */
const hasRows = async (modelName, campusId, extraFilter = {}) => {
  const Model = resolveModel(modelName);
  const campusPath = resolveCampusPath(Model);
  if (!campusPath) return false;   // global collection — see the `level` note above

  const filter = {
    [campusPath]: campusId,
    ...(isSoftDeletable(Model) ? notDeletedFilter(Model) : {}),
    ...extraFilter,
  };
  const found = await Model.countDocuments(filter).limit(1);
  return found > 0;
};

/**
 * Structural blockers against hiding `key` on this campus.
 *
 * @param {string} key
 * @param {string} campusId
 * @returns {Promise<Array<{model: string, label: string}>>} empty ⇒ nothing blocks.
 */
const findUsageBlockers = async (key, campusId) => {
  const edges = HARD_EDGES[key] || [];
  const hits = await Promise.all(
    edges.map(async ({ model, path, label }) => {
      // `$ne: null` is a no-op while the reference stays `required`; it keeps
      // the filter honest the day the schema relaxes it.
      const used = await hasRows(model, campusId, { [path]: { $ne: null } });
      return used ? { model, label } : null;
    })
  );
  return hits.filter(Boolean);
};

/**
 * Institutional records forbidding `hidden` on a floored module (§4.1.1).
 * Every model named here is declared BLOCK in the hard-delete registry: a
 * record the platform refuses to DELETE is one it must equally refuse to HIDE,
 * or masking would achieve what deletion is denied — and without an audit row.
 *
 * @param {string} key
 * @param {string} campusId
 * @returns {Promise<Array<{model: string, label: string}>>}
 */
const findRecordBlockers = async (key, campusId) => {
  const records = FEATURE_REGISTRY[key]?.records || [];
  const hits = await Promise.all(
    records.map(async (model) => (await hasRows(model, campusId) ? { model, label: model } : null))
  );
  return hits.filter(Boolean);
};

module.exports = {
  CAMPUS_PATHS,
  HARD_EDGES,
  FEATURE_KEYS,
  resolveCampusPath,
  resolveModel,
  hasRows,
  findUsageBlockers,
  findRecordBlockers,
};
