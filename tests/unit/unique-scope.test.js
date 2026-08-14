'use strict';

/**
 * @file unique-scope.test.js
 * @description Regression tests for defect B8-⑦ — duplicate detection on import.
 *
 * `checkDuplicates` queried `{ [field]: value }` globally. Teacher declares
 * `{ schoolCampus, email }` unique, so an import into campus B was refused because campus
 * A already employed that address — a row the database itself would have accepted, refused
 * with a message that never mentions a campus.
 *
 * Part of this suite runs against the REAL Teacher and Student schemas, deliberately: the
 * two models use the two different declaration forms, and the day either changes its
 * uniqueness rule this suite says so — the same pin-the-convention approach as
 * tests/unit/soft-delete.test.js.
 */

const { uniqueScopeFor, buildUniquenessQuery } = require('../../shared/utils/unique-scope');
const Teacher = require('../../modules/teacher/models/teacher.model');
const Student = require('../../modules/student/models/student.model');

const CAMPUS_A = '507f1f77bcf86cd799439011';

describe('uniqueScopeFor — against the real schemas', () => {
  test('Teacher.email is scoped by campus (compound index form)', () => {
    expect(uniqueScopeFor(Teacher, 'email')).toEqual({
      scoped: true,
      scopeKeys: ['schoolCampus'],
    });
  });

  test('Student.email is global (path-option form)', () => {
    // The form that never appears in schema.indexes() — reading only that list is what
    // makes someone conclude Student.email carries no unique constraint at all.
    expect(uniqueScopeFor(Student, 'email')).toEqual({ scoped: false, scopeKeys: [] });
  });

  test('a field with no unique constraint stays global — fail closed', () => {
    // Widening here would let genuine duplicates through, which is worse than the false
    // rejection this helper removes.
    expect(uniqueScopeFor(Teacher, 'firstName')).toEqual({ scoped: false, scopeKeys: [] });
  });

  test('a model with no schema does not throw', () => {
    expect(uniqueScopeFor({}, 'email')).toEqual({ scoped: false, scopeKeys: [] });
  });
});

describe('uniqueScopeFor — declaration forms in isolation', () => {
  const schemaStub = ({ indexes = [], paths = {} }) => ({
    schema: {
      indexes: () => indexes,
      path: (name) => paths[name],
    },
  });

  test('a single-key unique index is a GLOBAL constraint, not a scoped one', () => {
    const Model = schemaStub({ indexes: [[{ email: 1 }, { unique: true }]] });
    expect(uniqueScopeFor(Model, 'email')).toEqual({ scoped: false, scopeKeys: [] });
  });

  test('a compound index that is not unique does not scope anything', () => {
    const Model = schemaStub({
      indexes: [[{ schoolCampus: 1, email: 1 }, {}]],
      paths: { email: { options: { unique: true } } },
    });
    expect(uniqueScopeFor(Model, 'email')).toEqual({ scoped: false, scopeKeys: [] });
  });

  test('a three-key unique index yields both other keys as scope', () => {
    const Model = schemaStub({
      indexes: [[{ schoolCampus: 1, level: 1, className: 1 }, { unique: true }]],
    });
    expect(uniqueScopeFor(Model, 'className')).toEqual({
      scoped: true,
      scopeKeys: ['schoolCampus', 'level'],
    });
  });
});

describe('buildUniquenessQuery', () => {
  test('a Teacher lookup carries the campus', () => {
    const { query, scoped } = buildUniquenessQuery(
      Teacher, 'email', 'marie@univ.fr', { schoolCampus: CAMPUS_A },
    );

    expect(query).toEqual({ email: 'marie@univ.fr', schoolCampus: CAMPUS_A });
    expect(scoped).toBe(true);
  });

  test('a Student lookup stays global — no campus key is invented', () => {
    const { query, scoped } = buildUniquenessQuery(
      Student, 'email', 'a@b.fr', { schoolCampus: CAMPUS_A },
    );

    expect(query).toEqual({ email: 'a@b.fr' });
    expect(scoped).toBe(false);
  });

  test('an unavailable scope value is OMITTED, never queried as undefined', () => {
    // `{ email, schoolCampus: undefined }` matches on email alone in Mongo, which would
    // silently turn the scoped check back into the global one it replaces.
    const { query, scoped } = buildUniquenessQuery(Teacher, 'email', 'x@y.fr', {});

    expect(query).toEqual({ email: 'x@y.fr' });
    expect('schoolCampus' in query).toBe(false);
    expect(scoped).toBe(false); // reported unscoped, so the message stays the strict one
  });
});

describe('B8-⑦ — checkDuplicates, end to end', () => {
  const ImportService = require('../../shared/services/import.service');

  /** Model double that answers with a hit only when the query matches exactly. */
  const modelDouble = (schemaSource, hitOn) => {
    const queries = [];
    return {
      queries,
      schema: schemaSource.schema,
      findOne: (query) => {
        queries.push(query);
        const hit = hitOn && Object.entries(hitOn)
          .every(([k, v]) => String(query[k]) === String(v));
        return { lean: async () => (hit ? { _id: 'existing' } : null) };
      },
    };
  };

  test('a teacher email held in ANOTHER campus no longer blocks the import', () => {
    // The defect, in one assertion. The existing row is in campus A; the import targets
    // campus B; the global query used to find it and refuse a legitimate row.
    const CAMPUS_B = '507f1f77bcf86cd799439012';
    const Model = modelDouble(Teacher, { email: 'marie@univ.fr', schoolCampus: CAMPUS_A });
    const service = new ImportService(Model, { name: 'Teacher', uniqueFields: ['email'] });

    return service
      .checkDuplicates({ email: 'Marie@univ.fr' }, { schoolCampus: CAMPUS_B })
      .then((duplicates) => {
        expect(duplicates).toBeNull();
        expect(Model.queries[0]).toEqual({ email: 'marie@univ.fr', schoolCampus: CAMPUS_B });
      });
  });

  test('the SAME campus still refuses the duplicate', async () => {
    const Model = modelDouble(Teacher, { email: 'marie@univ.fr', schoolCampus: CAMPUS_A });
    const service = new ImportService(Model, { name: 'Teacher', uniqueFields: ['email'] });

    const duplicates = await service.checkDuplicates(
      { email: 'marie@univ.fr' }, { schoolCampus: CAMPUS_A },
    );

    expect(duplicates).toEqual(['email "marie@univ.fr" already exists in this campus']);
  });

  test('a student email is still global across campuses', async () => {
    const CAMPUS_B = '507f1f77bcf86cd799439012';
    const Model = modelDouble(Student, { email: 'a@b.fr' });
    const service = new ImportService(Model, { name: 'Student', uniqueFields: ['email'] });

    const duplicates = await service.checkDuplicates(
      { email: 'a@b.fr' }, { schoolCampus: CAMPUS_B },
    );

    expect(duplicates).toEqual(['email "a@b.fr" already exists']);
    expect(Model.queries[0]).toEqual({ email: 'a@b.fr' });
  });

  test('matricule keeps its global constraint even on a per-campus model', async () => {
    // Teacher scopes email but declares matricule unique on the path itself. Scoping the
    // whole row by campus would have been just as wrong in the other direction.
    const Model = modelDouble(Teacher, null);
    const service = new ImportService(Model, {
      name: 'Teacher',
      uniqueFields: ['email', 'matricule'],
    });

    await service.checkDuplicates(
      { email: 'x@y.fr', matricule: 'TCH-001' }, { schoolCampus: CAMPUS_A },
    );

    expect(Model.queries[0]).toEqual({ email: 'x@y.fr', schoolCampus: CAMPUS_A });
    expect(Model.queries[1]).toEqual({ matricule: 'TCH-001' });
  });
});
