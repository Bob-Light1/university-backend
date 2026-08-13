'use strict';

/**
 * @file soft-delete-stub.js
 * @description Minimal schema stub that makes a mocked Mongoose model readable by
 * `shared/utils/soft-delete`.
 *
 * Repositories no longer hard-code their not-deleted filter: they derive it from the model
 * (CLAUDE.md §5.1). A mock that is a bare bag of `jest.fn()` therefore no longer stands in
 * for a model — the helper introspects the schema and fails closed when it finds none.
 *
 * Declaring the marker explicitly in the mock is deliberate: it states, in the repository's
 * own test, which convention that repository assumes. `tests/unit/soft-delete.test.js` pins
 * the same conventions against the REAL schemas, so the pair catches a drift from either
 * side — a model whose marker changed, or a repository built on the wrong assumption.
 */

/** Schema paths each marker exposes, in the shape `detectStrategy()` reads. */
const MARKER_PATHS = Object.freeze({
  isDeleted: { isDeleted: { instance: 'Boolean' } },
  deletedAt: { deletedAt: { instance: 'Date' } },
  deletedBy: { deletedBy: { instance: 'String' } },
  status:    { status: { enumValues: ['active', 'archived'], options: { default: 'active' } } },
});

/**
 * Builds the `schema` half of a model mock.
 *
 * Several markers may be declared at once — `Course` and `Announcement` genuinely carry
 * both a `status` enum and `deletedAt`, and which one means "deleted" is settled by
 * `STRATEGY_OVERRIDES` keyed on `modelName`, not by the schema. A mock of either MUST
 * declare both, or `softDeletePatch()` silently stops writing the companion timestamp.
 *
 * @param {'isDeleted'|'deletedAt'|'deletedBy'|'status'|Array<string>} markers
 * @returns {{ path: (name: string) => Object|undefined }}
 * @throws {Error} On an unknown marker — a typo would otherwise mock a model with no
 *                 convention at all, which is exactly the failure being guarded against.
 */
const softDeleteSchemaStub = (markers) => {
  const requested = Array.isArray(markers) ? markers : [markers];

  const paths = requested.reduce((acc, marker) => {
    if (!MARKER_PATHS[marker]) {
      throw new Error(
        `softDeleteSchemaStub: unknown marker '${marker}' — expected one of ` +
        `${Object.keys(MARKER_PATHS).join(', ')}. See CLAUDE.md §5.1.`
      );
    }
    return { ...acc, ...MARKER_PATHS[marker] };
  }, {});

  return { path: (name) => paths[name] };
};

module.exports = { softDeleteSchemaStub };
