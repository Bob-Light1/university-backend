'use strict';

/**
 * @file generic-bulk.controller.test.js
 * @description Regression tests for GenericBulkController — defects B6-⑤ and B6-④.
 *
 * B6-⑤ — the related-entity campus check read `relatedEntity.campus`. Neither Class nor
 * Department declares that path; both declare `schoolCampus`. Reading a path a schema does
 * not have raises nothing, it yields `undefined` — which never equals the caller's campus,
 * so EVERY CAMPUS_MANAGER got 403 on bulk change. The bug fails closed, which is why it
 * reads as a missing feature rather than as a breach and survived unreported.
 *
 * The decisive assertion is therefore the POSITIVE one: a CAMPUS_MANAGER acting inside
 * their own campus must be allowed through. A test that only pins the 403 passes against
 * the broken code.
 *
 * B6-④ — the constructor read `config.exportColumns`, while both callers
 * (teacher.controller.js, student.controller.js) declare `columns`. Every export fell back
 * to the student-shaped default columns.
 */

jest.mock('../../shared/utils/response-helpers', () => ({
  sendSuccess: jest.fn((res, code, message, data) => ({ code, message, data })),
  sendError:   jest.fn((res, code, message) => ({ code, message })),
  sendNotFound: jest.fn((res, name) => ({ code: 404, name })),
}));

const mongoose = require('mongoose');

const session = {
  startTransaction:  jest.fn(),
  abortTransaction:  jest.fn().mockResolvedValue(),
  commitTransaction: jest.fn().mockResolvedValue(),
  endSession:        jest.fn(),
};
jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);

const GenericBulkController = require('../../shared/lib/generic-bulk.controller');

const CAMPUS_A = '507f1f77bcf86cd799439011';
const CAMPUS_B = '507f1f77bcf86cd799439012';
const CLASS_ID = '507f1f77bcf86cd799439013';
const ENTITY_ID = '507f1f77bcf86cd799439014';

/**
 * Model double: `find(...).session(...)` resolves to the given entities, `updateMany`
 * reports what it touched.
 */
const buildModel = (entities) => ({
  find: jest.fn(() => ({ session: jest.fn().mockResolvedValue(entities) })),
  updateMany: jest.fn().mockResolvedValue({ modifiedCount: entities.length }),
});

/**
 * Builds a controller whose related entity lives on `relatedCampus`, shaped like the real
 * Class / Department documents: the campus reference is on `schoolCampus`.
 */
const buildController = (relatedCampus, entities) =>
  new GenericBulkController(buildModel(entities), {
    entityName: 'Student',
    relatedField: 'studentClass',
    findRelatedById: jest.fn().mockResolvedValue({
      _id: CLASS_ID,
      schoolCampus: relatedCampus,
    }),
  });

const managerReq = (campusId) => ({
  user: { role: 'CAMPUS_MANAGER', campusId },
  body: { entityIds: [ENTITY_ID], newRelatedId: CLASS_ID },
});

const res = {};

beforeEach(() => jest.clearAllMocks());

describe('B6-⑤ — bulkChangeRelated campus isolation reads the path the schema declares', () => {
  test('a CAMPUS_MANAGER moving an entity inside their own campus is ALLOWED', async () => {
    const controller = buildController(CAMPUS_A, [{ _id: ENTITY_ID, schoolCampus: CAMPUS_A }]);

    const out = await controller.bulkChangeRelated(managerReq(CAMPUS_A), res);

    // The assertion that fails against `relatedEntity.campus`: undefined !== CAMPUS_A → 403.
    expect(out.code).toBe(200);
    expect(controller.Model.updateMany).toHaveBeenCalled();
    expect(session.commitTransaction).toHaveBeenCalled();
    expect(session.abortTransaction).not.toHaveBeenCalled();
  });

  test('a CAMPUS_MANAGER moving into ANOTHER campus is refused', async () => {
    const controller = buildController(CAMPUS_B, [{ _id: ENTITY_ID, schoolCampus: CAMPUS_A }]);

    const out = await controller.bulkChangeRelated(managerReq(CAMPUS_A), res);

    expect(out.code).toBe(403);
    expect(controller.Model.updateMany).not.toHaveBeenCalled();
    expect(session.abortTransaction).toHaveBeenCalled();
  });

  test('an entity from another campus is refused even when the target class is in scope', async () => {
    const controller = buildController(CAMPUS_A, [{ _id: ENTITY_ID, schoolCampus: CAMPUS_B }]);

    const out = await controller.bulkChangeRelated(managerReq(CAMPUS_A), res);

    expect(out.code).toBe(403);
    expect(controller.Model.updateMany).not.toHaveBeenCalled();
  });

  test('a related entity carrying no campus at all is refused, not let through', async () => {
    const controller = new GenericBulkController(
      buildModel([{ _id: ENTITY_ID, schoolCampus: CAMPUS_A }]),
      {
        entityName: 'Student',
        relatedField: 'studentClass',
        findRelatedById: jest.fn().mockResolvedValue({ _id: CLASS_ID }),
      },
    );

    const out = await controller.bulkChangeRelated(managerReq(CAMPUS_A), res);

    expect(out.code).toBe(403);
  });

  test('a global role is not campus-checked', async () => {
    const controller = buildController(CAMPUS_B, [{ _id: ENTITY_ID, schoolCampus: CAMPUS_B }]);

    const out = await controller.bulkChangeRelated(
      { user: { role: 'ADMIN' }, body: { entityIds: [ENTITY_ID], newRelatedId: CLASS_ID } },
      res,
    );

    expect(out.code).toBe(200);
  });
});

describe('B8-⑥ — the import campus is derived from the role, never read from the body', () => {
  /** Controller whose ImportService is replaced by a spy, so no file is ever parsed. */
  const buildImportController = () => {
    const controller = new GenericBulkController(buildModel([]), { entityName: 'Student' });
    controller.importService = {
      import: jest.fn().mockResolvedValue({ message: 'ok', data: { imported: 1 } }),
    };
    return controller;
  };

  const importReq = (user, bodyCampusId) => ({
    user,
    body: bodyCampusId === undefined ? {} : { campusId: bodyCampusId },
    file: { path: '/tmp/x.csv', originalname: 'x.csv' },
  });

  test('a CAMPUS_MANAGER importing into their own campus is allowed', async () => {
    const controller = buildImportController();

    const out = await controller.importFromFile(importReq(
      { role: 'CAMPUS_MANAGER', campusId: CAMPUS_A }, CAMPUS_A,
    ), res);

    expect(out.code).toBe(200);
    expect(controller.importService.import).toHaveBeenCalledWith(
      expect.anything(), CAMPUS_A, expect.anything(),
    );
  });

  test('a CAMPUS_MANAGER naming ANOTHER campus is refused', async () => {
    const controller = buildImportController();

    const out = await controller.importFromFile(importReq(
      { role: 'CAMPUS_MANAGER', campusId: CAMPUS_A }, CAMPUS_B,
    ), res);

    expect(out.code).toBe(403);
    expect(controller.importService.import).not.toHaveBeenCalled();
  });

  test('a scoped role the old inline check did not name is ALSO pinned to its own campus', async () => {
    // The defect in one assertion: the replaced check tested `userRole === 'CAMPUS_MANAGER'`
    // and nothing else, so any other scoped role had req.body.campusId honoured — an
    // entire cohort written into another tenant.
    const controller = buildImportController();

    const out = await controller.importFromFile(importReq(
      { role: 'TEACHER', campusId: CAMPUS_A }, CAMPUS_B,
    ), res);

    expect(out.code).toBe(403);
    expect(controller.importService.import).not.toHaveBeenCalled();
  });

  test('a scoped role naming no campus gets its own, not undefined', async () => {
    const controller = buildImportController();

    const out = await controller.importFromFile(importReq(
      { role: 'CAMPUS_MANAGER', campusId: CAMPUS_A }, undefined,
    ), res);

    expect(out.code).toBe(200);
    expect(controller.importService.import).toHaveBeenCalledWith(
      expect.anything(), CAMPUS_A, expect.anything(),
    );
  });

  test('a scoped token carrying no campus is refused 403, not defaulted', async () => {
    const controller = buildImportController();

    const out = await controller.importFromFile(importReq(
      { role: 'CAMPUS_MANAGER', campusId: null }, CAMPUS_B,
    ), res);

    expect(out.code).toBe(403);
    expect(controller.importService.import).not.toHaveBeenCalled();
  });

  test('a global role may target any campus, which is the point of being global', async () => {
    const controller = buildImportController();

    const out = await controller.importFromFile(importReq({ role: 'ADMIN' }, CAMPUS_B), res);

    expect(out.code).toBe(200);
    expect(controller.importService.import).toHaveBeenCalledWith(
      expect.anything(), CAMPUS_B, expect.anything(),
    );
  });

  test('a global role naming no campus gets 400, not an import into nowhere', async () => {
    const controller = buildImportController();

    const out = await controller.importFromFile(importReq({ role: 'ADMIN' }, undefined), res);

    expect(out.code).toBe(400);
    expect(controller.importService.import).not.toHaveBeenCalled();
  });

  test('the service refuses an unresolved campus on its own', async () => {
    // Defence in depth, not a second policy: the service cannot see `req`, so it cannot
    // decide the campus — it can only refuse to write rows that belong to no tenant.
    const ImportService = require('../../shared/services/import.service');
    const service = new ImportService({}, { name: 'Student' });

    await expect(service.import({ path: '/tmp/x.csv', originalname: 'x.csv' }, null))
      .rejects.toThrow(/campus is not resolved/i);
  });
});

describe('B6-④ — the caller\'s export columns are the ones used', () => {
  const TEACHER_COLUMNS = [
    { header: 'Matricule', key: 'matricule', width: 15 },
    { header: 'Date of Birth', key: 'dateOfBirth', width: 15, format: 'date' },
  ];

  test('`columns`, the name both real callers declare, reaches ExportService', () => {
    const controller = new GenericBulkController(buildModel([]), {
      entityName: 'Teacher',
      columns: TEACHER_COLUMNS,
    });

    expect(controller.exportService.entityConfig.columns).toEqual(TEACHER_COLUMNS);
  });

  test('`exportColumns` keeps working and still wins', () => {
    const controller = new GenericBulkController(buildModel([]), {
      entityName: 'Teacher',
      exportColumns: TEACHER_COLUMNS,
      columns: [{ header: 'Ignored', key: 'ignored' }],
    });

    expect(controller.exportService.entityConfig.columns).toEqual(TEACHER_COLUMNS);
  });

  test('neither declared → the default columns, unchanged', () => {
    const controller = new GenericBulkController(buildModel([]), { entityName: 'Student' });

    expect(controller.exportService.entityConfig.columns)
      .toEqual(controller.getDefaultExportColumns());
  });

  test('the real Teacher config no longer falls back to the student default', () => {
    // Pins the actual defect: the Teacher export used to carry a `studentClass.className`
    // column — a path Teacher has no schema entry for, so a blank column — and lost the
    // Date of Birth column its own config declares.
    const teacherExportConfig = {
      name: 'Teacher',
      columns: TEACHER_COLUMNS,
      populateFields: [{ path: 'schoolCampus', select: 'campus_name' }],
    };

    const controller = new GenericBulkController(buildModel([]), {
      entityName: 'Teacher',
      ...teacherExportConfig,
    });

    const keys = controller.exportService.entityConfig.columns.map((c) => c.key);
    expect(keys).toContain('dateOfBirth');
    expect(keys).not.toContain('studentClass.className');
  });
});
