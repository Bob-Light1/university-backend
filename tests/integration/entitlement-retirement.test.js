'use strict';

/**
 * @file entitlement-retirement.test.js
 * @description Retired configuration cannot be written; unified administration
 * retains historical decisions behind the existing global-role authorization.
 */
const request = require('supertest');
const jwt = require('jsonwebtoken');
const express = require('express');

jest.mock('../../modules/campus', () => ({ service: {
  getCampusEntitlementWithAudit: jest.fn(),
  getCampusAiEntitlementWithAudit: jest.fn().mockResolvedValue(null),
  getCampusAiEntitlement: jest.fn().mockResolvedValue(null),
} }));
jest.mock('../../shared/lib/entitlement/entitlement.service', () => ({
  describeForCampus: jest.fn().mockResolvedValue({ found: true }),
}));

const Campus = require('../../modules/campus/campus.model');
const campusService = require('../../modules/campus').service;
const { FEATURE_PLANS } = require('../../shared/constants/features.constants');
const app = express();
app.use(express.json());
app.use('/api/admin', require('../../modules/admin/admin.routes'));
const id = '507f1f77bcf86cd799439012';
const url = `/api/admin/campuses/${id}/entitlement`;
const token = (role) => jwt.sign({ id, role }, process.env.JWT_SECRET,
  { issuer: 'school-management-app' });

beforeEach(() => {
  jest.clearAllMocks();
  campusService.getCampusEntitlementWithAudit.mockResolvedValue({
    entitlement: { plan: FEATURE_PLANS.PREMIUM },
    aiEntitlementAudit: [{ at: '2026-01-01', actorRole: 'ADMIN', changes: { legacy: true } }],
    entitlementAudit: [{ at: '2026-02-01', actorRole: 'ADMIN', changes: { unified: true } }],
  });
});

test('new campus documents discard retired configuration without enabling a default plan', () => {
  const campus = new Campus({ features: { maxStudents: 2 }, aiEntitlement: { enabled: true } });
  const raw = campus.toObject();
  expect(raw).not.toHaveProperty('features');
  expect(raw).not.toHaveProperty('aiEntitlement');
  expect(raw.entitlement).toBeUndefined();
  expect(Campus.schema.path('aiEntitlementAudit').options.select).toBe(false);
});

test.each([
  ['canAddStudent', 'maxStudents', '../../modules/student/models/student.model'],
  ['canAddTeacher', 'maxTeachers', '../../modules/teacher/models/teacher.model'],
  ['canAddClass', 'maxClasses', '../../modules/class/class.model'],
])('hydrating an old campus preserves the quota used by %s', async (method, quota, modelPath) => {
  const Model = require(modelPath);
  const count = jest.spyOn(Model, 'countDocuments').mockResolvedValue(2);
  try {
    const campus = Campus.hydrate({ _id: id, features: { [quota]: 1 } });
    expect(await campus[method]()).toBe(false);
  } finally {
    count.mockRestore();
  }
});

test('hydrating an old campus preserves its document storage quota', async () => {
  const Document = require('../../modules/document/models/document.model');
  const aggregate = jest.spyOn(Document, 'aggregate').mockResolvedValue([{ total: 1024 * 1024 }]);
  try {
    const campus = Campus.hydrate({ _id: id, features: { maxDocumentStorageMB: 1 } });
    expect(await campus.canAddDocumentStorage(1)).toBe(false);
  } finally {
    aggregate.mockRestore();
  }
});

test.each(['get', 'put'])('the retired AI administration %s route is absent', async (method) => {
  const res = await request(app)[method](`/api/admin/campuses/${id}/ai-entitlement`)
    .set('Authorization', `Bearer ${token('ADMIN')}`).send({ enabled: true });
  expect(res.status).toBe(404);
  expect(campusService.getCampusAiEntitlementWithAudit).not.toHaveBeenCalled();
  expect(campusService.getCampusAiEntitlement).not.toHaveBeenCalled();
});

test.each(['ADMIN', 'DIRECTOR'])('%s can read both audit histories through the unified endpoint', async (role) => {
  const res = await request(app).get(url).set('Authorization', `Bearer ${token(role)}`);
  expect(res.status).toBe(200);
  expect(res.body.data.audit.map((row) => row.changes))
    .toEqual([{ unified: true }, { ai: { legacy: true } }]);
});

test('the combined history is sorted before applying the latest-twenty limit', async () => {
  const rows = Array.from({ length: 24 }, (_, i) => ({
    at: new Date(Date.UTC(2026, 0, i + 1)), actorRole: 'ADMIN', changes: { ordinal: i },
  }));
  campusService.getCampusEntitlementWithAudit.mockResolvedValue({
    entitlement: { plan: FEATURE_PLANS.PREMIUM },
    aiEntitlementAudit: rows.filter((_, i) => i % 2 === 0).reverse(),
    entitlementAudit: rows.filter((_, i) => i % 2 === 1),
  });
  const res = await request(app).get(url).set('Authorization', `Bearer ${token('ADMIN')}`);
  expect(res.body.data.audit.map((row) => row.changes.ordinal ?? row.changes.ai?.ordinal))
    .toEqual(rows.slice(4).reverse().map((row) => row.changes.ordinal));
});

test.each(['CAMPUS_MANAGER', 'PARENT', 'MENTOR', 'STAFF'])('%s cannot obtain administrative history', async (role) => {
  const res = await request(app).get(url).set('Authorization', `Bearer ${token(role)}`);
  expect(res.status).toBe(403);
});
