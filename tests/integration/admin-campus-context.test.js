'use strict';

/**
 * @file admin-campus-context.test.js
 * @description AP-01/AP-08 regressions through real routes, auth and campus guards.
 * Persistence is mocked; the browser act additionally verifies real database writes.
 */
jest.mock('../../modules/result/result.repository', () => ({
  ...jest.requireActual('../../modules/result/result.repository'),
  updateManyResults: jest.fn(),
  aggregateDistinctStudentsForLock: jest.fn(),
  listTranscriptsForRanking: jest.fn(),
  findResultForWrite: jest.fn(), findResultByIdPopulated: jest.fn(),
}));
jest.mock('../../modules/mentor/mentor.repository', () => ({
  ...jest.requireActual('../../modules/mentor/mentor.repository'), paginate: jest.fn(),
}));
jest.mock('../../modules/staff/staff.repository', () => ({
  ...jest.requireActual('../../modules/staff/staff.repository'), paginate: jest.fn(),
}));
jest.mock('../../shared/lib/entitlement/entitlement.service', () => ({
  ...jest.requireActual('../../shared/lib/entitlement/entitlement.service'),
  resolveForCampus: jest.fn(),
}));

jest.mock('../../modules/document/document.repository', () => ({
  ...jest.requireActual('../../modules/document/document.repository'), paginateDocuments: jest.fn(),
}));
const documents = require('../../modules/document/document.repository');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../app');
const results = require('../../modules/result/result.repository');
const mentors = require('../../modules/mentor/mentor.repository');
const staff = require('../../modules/staff/staff.repository');
const entitlement = require('../../shared/lib/entitlement/entitlement.service');
const { resolveEntitlement } = require('../../shared/utils/entitlement');
const A = '507f1f77bcf86cd799439012';
const B = '507f1f77bcf86cd799439013';
const period = { academicYear: '2025-2026', semester: 'S1' };
const token = (role) => jwt.sign({ id: '507f1f77bcf86cd799439011', role,
  ...(role === 'CAMPUS_MANAGER' ? { campusId: A } : {}) }, process.env.JWT_SECRET,
{ issuer: 'school-management-app' });
const call = (role, query = '', body = period) => request(app)
  .patch(`/api/results/lock-semester${query}`).auth(token(role), { type: 'bearer' }).send(body);

beforeEach(() => {
  jest.clearAllMocks();
  documents.paginateDocuments.mockResolvedValue({ data: [], total: 0 });
  entitlement.resolveForCampus.mockResolvedValue(resolveEntitlement({ plan: 'premium' }));
  results.findResultForWrite.mockResolvedValue(null);
  results.findResultByIdPopulated.mockResolvedValue(null);
  results.updateManyResults.mockResolvedValue({ modifiedCount: 18 });
  results.aggregateDistinctStudentsForLock.mockResolvedValue([]);
  results.listTranscriptsForRanking.mockResolvedValue([]);
  mentors.paginate.mockResolvedValue({ data: [], total: 0 });
  staff.paginate.mockResolvedValue({ data: [], total: 0 });
});

describe('AP-01 semester closure', () => {
  test.each(['ADMIN', 'DIRECTOR'])('%s cannot accidentally close every campus', async (role) => {
    expect((await call(role)).status).toBe(400);
    expect(results.updateManyResults).not.toHaveBeenCalled();
  });
  test.each(['ADMIN', 'DIRECTOR'])('%s scopes locking, snapshots and ranking', async (role) => {
    expect((await call(role, `?campusId=${A}`)).status).toBe(200);
    expect(results.updateManyResults.mock.calls[0][0]).toMatchObject({ schoolCampus: new (require('mongoose').Types.ObjectId)(A), ...period });
    const aggregateCampus = results.aggregateDistinctStudentsForLock.mock.calls[0][0].schoolCampus;
    expect(aggregateCampus).toBeInstanceOf(require('mongoose').Types.ObjectId);
    expect(String(aggregateCampus)).toBe(A);
    expect(results.listTranscriptsForRanking.mock.calls[0][0]).toMatchObject({ schoolCampus: new (require('mongoose').Types.ObjectId)(A) });
  });
  test('the documented schoolCampus body is honored for a global actor', async () => {
    expect((await call('ADMIN', '', { ...period, schoolCampus: A })).status).toBe(200);
    expect(results.updateManyResults.mock.calls[0][0]).toMatchObject({ schoolCampus: new (require('mongoose').Types.ObjectId)(A) });
  });
  test('invalid campus cannot fall back to a global write', async () => {
    expect((await call('ADMIN', '?campusId=invalid')).status).toBe(400);
    expect(results.updateManyResults).not.toHaveBeenCalled();
  });
  test('conflicting requested campuses are rejected', async () => {
    expect((await call('ADMIN', `?campusId=${A}`, { ...period, schoolCampus: B })).status).toBe(400);
    expect(results.updateManyResults).not.toHaveBeenCalled();
  });
  test('a manager cannot override authenticated campus with query or body', async () => {
    expect((await call('CAMPUS_MANAGER', `?campusId=${B}`, { ...period, schoolCampus: B })).status).toBe(200);
    expect(results.updateManyResults.mock.calls[0][0]).toMatchObject({ schoolCampus: new (require('mongoose').Types.ObjectId)(A) });
  });
});

describe.each([['mentors', mentors], ['staff', staff]])('AP-08 %s', (route, repo) => {
  test.each(['ADMIN', 'DIRECTOR'])('%s honors an explicit campus', async (role) => {
    const res = await request(app).get(`/api/${route}?campusId=${A}`).auth(token(role), { type: 'bearer' });
    expect(res.status).toBe(200);
    expect(repo.paginate.mock.calls[0][0].campusFilter).toEqual({ schoolCampus: A });
  });
  test('global listing is preserved without a campus', async () => {
    expect((await request(app).get(`/api/${route}`).auth(token('ADMIN'), { type: 'bearer' })).status).toBe(200);
    expect(repo.paginate.mock.calls[0][0].campusFilter).toEqual({});
  });
  test('manager query cannot broaden scope', async () => {
    expect((await request(app).get(`/api/${route}?campusId=${B}`).auth(token('CAMPUS_MANAGER'), { type: 'bearer' })).status).toBe(200);
    expect(repo.paginate.mock.calls[0][0].campusFilter).toEqual({ schoolCampus: A });
  });
});


describe('AP-07 document campus listing', () => {
  test.each(['ADMIN', 'DIRECTOR'])('%s honors the requested campus', async role => {
    expect((await request(app).get(`/api/documents?campusId=${A}`).auth(token(role), { type: 'bearer' })).status).toBe(200);
    expect(documents.paginateDocuments.mock.calls[0][0]).toMatchObject({ campusId: A });
  });
  test('manager retains identity scope despite a conflicting query', async () => {
    expect((await request(app).get(`/api/documents?campusId=${B}`).auth(token('CAMPUS_MANAGER'), { type: 'bearer' })).status).toBe(200);
    expect(documents.paginateDocuments.mock.calls[0][0]).toMatchObject({ campusId: A });
  });
  test('global listing remains available without a campus', async () => {
    expect((await request(app).get('/api/documents').auth(token('ADMIN'), { type: 'bearer' })).status).toBe(200);
    expect(documents.paginateDocuments.mock.calls[0][0]).not.toHaveProperty('campusId');
  });
  test('invalid campus is rejected instead of broadening the listing', async () => {
    expect((await request(app).get('/api/documents?campusId=invalid').auth(token('ADMIN'), { type: 'bearer' })).status).toBe(400);
    expect(documents.paginateDocuments).not.toHaveBeenCalled();
  });
});


describe('AP-01 selected-campus single-result operations', () => {
  test.each([
    ['get', '', 'findResultByIdPopulated'],
    ['put', '', 'findResultForWrite'],
    ['delete', '', 'findResultForWrite'],
    ['post', '/submit', 'findResultForWrite'],
    ['patch', '/publish', 'findResultForWrite'],
    ['patch', '/archive', 'findResultForWrite'],
  ])('%s %s scopes the repository lookup', async (method, action, lookup) => {
    const res = await request(app)[method](`/api/results/${B}${action}?campusId=${A}`)
      .auth(token('ADMIN'), { type: 'bearer' }).send({});
    expect(res.status).toBe(404);
    expect(results[lookup]).toHaveBeenCalledWith(B, { schoolCampus: new (require('mongoose').Types.ObjectId)(A) });
    expect(results.updateManyResults).not.toHaveBeenCalled();
  });
});
