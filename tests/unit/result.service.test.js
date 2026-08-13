'use strict';

/**
 * Service — AI analytics aggregate facades (result.service, design §8/M5).
 * Repository and model mocked (no DB). Non-regression on the FIGURES the AI
 * narrates: filter building (campus isolation + validated academic filters),
 * flat shaping of the campus overview, and the zeroed default of the dropout
 * distribution — the LLM never computes any of these numbers (ADR-4).
 */

jest.mock('../../modules/result/result.repository', () => ({
  aggregateCampusOverview: jest.fn(async () => [
    {
      byStatus: [{ _id: 'PUBLISHED', count: 40 }, { _id: 'DRAFT', count: 5 }],
      byEvalType: [{ _id: 'EXAM', count: 30 }],
      byExamPeriod: [{ _id: 'Final', count: 20 }],
      generalStats: [{
        _id: null, avgNormalized: 12.34, passingRate: 71.4,
        totalPublished: 40, retakeEligible: 6, atRisk: 3, absentStudents: 2,
      }],
    },
  ]),
  aggregateDropoutRiskDistribution: jest.fn(async () => []),
}));

// The service only imports SEMESTER from the model (enum source of truth).
jest.mock('../../modules/result/models/result.model', () => ({
  SEMESTER: { S1: 'S1', S2: 'S2', ANNUAL: 'Annual' },
}));

const mongoose = require('mongoose');
const repo = require('../../modules/result/result.repository');
const service = require('../../modules/result/result.service');

const CAMPUS = 'c'.repeat(24);
// Aggregation pipelines do not auto-cast: the facades MUST cast the campus id
// (a string would silently match nothing — caught by the M5 real-boot check).
const CAMPUS_OID = new mongoose.Types.ObjectId(CAMPUS);

beforeEach(() => jest.clearAllMocks());

describe('validation helpers (owning-module truth)', () => {
  test('isValidAcademicYear : format YYYY-YYYY uniquement', () => {
    expect(service.isValidAcademicYear('2025-2026')).toBe(true);
    expect(service.isValidAcademicYear('2025')).toBe(false);
    expect(service.isValidAcademicYear('25-26')).toBe(false);
  });

  test('isValidSemester : enum du modèle', () => {
    expect(service.isValidSemester('S1')).toBe(true);
    expect(service.isValidSemester('Annual')).toBe(true);
    expect(service.isValidSemester('T1')).toBe(false);
  });
});

describe('getCampusOverviewAggregates', () => {
  // Le filtre de suppression n'est plus restitué ici : il est appliqué par le repository,
  // seul propriétaire du modèle (cf. result.repository.test — aggregateCampusOverview).
  test('filtre : isolation campus (id casté ObjectId), filtres académiques validés', async () => {
    await service.getCampusOverviewAggregates({
      campusId: CAMPUS, academicYear: '2025-2026', semester: 'S1',
    });
    expect(repo.aggregateCampusOverview).toHaveBeenCalledWith({
      schoolCampus: CAMPUS_OID, academicYear: '2025-2026', semester: 'S1',
    });
  });

  test('filtres invalides ignorés (jamais passés au pipeline)', async () => {
    await service.getCampusOverviewAggregates({
      campusId: CAMPUS, academicYear: 'not-a-year', semester: 'T9',
    });
    expect(repo.aggregateCampusOverview).toHaveBeenCalledWith({
      schoolCampus: CAMPUS_OID,
    });
  });

  test('mise en forme plate : facettes en objets + generalStats fusionné sans _id', async () => {
    const figures = await service.getCampusOverviewAggregates({ campusId: CAMPUS });
    expect(figures).toEqual({
      byStatus: { PUBLISHED: 40, DRAFT: 5 },
      byEvalType: { EXAM: 30 },
      byExamPeriod: { Final: 20 },
      avgNormalized: 12.34,
      passingRate: 71.4,
      totalPublished: 40,
      retakeEligible: 6,
      atRisk: 3,
      absentStudents: 2,
    });
  });
});

describe('getDropoutRiskDistribution', () => {
  test('filtre : campus casté ObjectId + PUBLISHED/ARCHIVED + isDeleted', async () => {
    await service.getDropoutRiskDistribution({ campusId: CAMPUS, semester: 'S2' });
    expect(repo.aggregateDropoutRiskDistribution).toHaveBeenCalledWith({
      schoolCampus: CAMPUS_OID,
      status: { $in: ['PUBLISHED', 'ARCHIVED'] },
      isDeleted: false,
      semester: 'S2',
    });
  });

  test('campus sans score calculé → distribution zéro explicite (jamais undefined)', async () => {
    const figures = await service.getDropoutRiskDistribution({ campusId: CAMPUS });
    expect(figures).toEqual({
      studentsAssessed: 0, avgRiskScore: null, lowRisk: 0, moderateRisk: 0, highRisk: 0,
    });
  });

  test('distribution du pipeline renvoyée telle quelle (chiffres ERP verbatim)', async () => {
    const erpFigures = { studentsAssessed: 25, avgRiskScore: 31.2, lowRisk: 15, moderateRisk: 7, highRisk: 3 };
    repo.aggregateDropoutRiskDistribution.mockResolvedValueOnce([erpFigures]);
    const figures = await service.getDropoutRiskDistribution({ campusId: CAMPUS });
    expect(figures).toEqual(erpFigures);
  });
});
