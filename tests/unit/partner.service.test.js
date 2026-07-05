'use strict';

/**
 * Service — AI advisor aggregate facade (partner.service, design §6.5/M5b).
 * Repository mocked (no DB). Non-regression on the lead-funnel FIGURES the
 * marketing advisor consumes: campus isolation (ObjectId cast — pipelines do
 * not auto-cast), honeypot rows excluded everywhere, PII-free shapes, and a
 * continuous zero-filled weekly series (the anomaly z-score needs even
 * spacing; a quiet week is a signal, never a hole).
 */

jest.mock('../../modules/partner/partner.repository', () => ({
  aggregateLeadConversionStats: jest.fn(async () => []),
  aggregateLeadStatusStats: jest.fn(async () => []),
  aggregateLeadSourceStats: jest.fn(async () => []),
  aggregateLeadFraudStats: jest.fn(async () => []),
  aggregateLeadWeeklyCounts: jest.fn(async () => []),
}));

const mongoose = require('mongoose');
const repo = require('../../modules/partner/partner.repository');
const service = require('../../modules/partner/partner.service');

const CAMPUS = 'a'.repeat(24);
const CAMPUS_OID = new mongoose.Types.ObjectId(CAMPUS);

beforeAll(() => {
  jest.useFakeTimers();
  // Saturday 2026-07-04 → current ISO week is 2026-W27.
  jest.setSystemTime(new Date('2026-07-04T10:00:00Z'));
});
afterAll(() => jest.useRealTimers());
beforeEach(() => jest.clearAllMocks());

describe('getLeadFunnelAggregates (M5b)', () => {
  test('scope : campus casté ObjectId + honeypot exclu sur chaque pipeline', async () => {
    await service.getLeadFunnelAggregates({ campusId: CAMPUS });
    const expected = { schoolCampus: CAMPUS_OID, honeypotTripped: false };
    expect(repo.aggregateLeadConversionStats).toHaveBeenCalledWith(expected);
    expect(repo.aggregateLeadStatusStats).toHaveBeenCalledWith(expected);
    expect(repo.aggregateLeadSourceStats).toHaveBeenCalledWith(expected);
    expect(repo.aggregateLeadFraudStats).toHaveBeenCalledWith(expected);
    // Weekly series additionally bounded to the 8-week window.
    expect(repo.aggregateLeadWeeklyCounts).toHaveBeenCalledWith({
      ...expected, createdAt: { $gte: expect.any(Date) },
    });
  });

  test('figures : maps par statut/source/flag + taux de conversion arrondi', async () => {
    repo.aggregateLeadConversionStats.mockResolvedValueOnce([{ total: 60, enrolled: 6 }]);
    repo.aggregateLeadStatusStats.mockResolvedValueOnce([
      { _id: 'new', count: 30 }, { _id: 'enrolled', count: 6 },
    ]);
    repo.aggregateLeadSourceStats.mockResolvedValueOnce([
      { _id: 'qr_code', total: 40, enrolled: 4 },
    ]);
    repo.aggregateLeadFraudStats.mockResolvedValueOnce([{ _id: 'IP_BURST', count: 3 }]);

    const figures = await service.getLeadFunnelAggregates({ campusId: CAMPUS });
    expect(figures.totalLeads).toBe(60);
    expect(figures.enrolledLeads).toBe(6);
    expect(figures.conversionRate).toBe(10);
    expect(figures.byStatus).toEqual({ new: 30, enrolled: 6 });
    expect(figures.bySource).toEqual({ qr_code: { total: 40, enrolled: 4 } });
    expect(figures.fraudFlags).toEqual({ IP_BURST: 3 });
  });

  test('série hebdomadaire : 8 semaines ISO continues, zéro-remplies, semaine courante en dernier', async () => {
    repo.aggregateLeadWeeklyCounts.mockResolvedValueOnce([
      { _id: { isoWeekYear: 2026, isoWeek: 27 }, count: 9 },
      { _id: { isoWeekYear: 2026, isoWeek: 24 }, count: 4 },
    ]);
    const { weeklyNewLeads } = await service.getLeadFunnelAggregates({ campusId: CAMPUS });

    expect(weeklyNewLeads).toHaveLength(8);
    expect(weeklyNewLeads.map((w) => w.isoWeek)).toEqual([20, 21, 22, 23, 24, 25, 26, 27]);
    expect(weeklyNewLeads.every((w) => w.isoWeekYear === 2026)).toBe(true);
    expect(weeklyNewLeads[7]).toEqual({ isoWeekYear: 2026, isoWeek: 27, count: 9 });
    expect(weeklyNewLeads[4]).toEqual({ isoWeekYear: 2026, isoWeek: 24, count: 4 });
    expect(weeklyNewLeads[0].count).toBe(0);
  });

  test('campus sans lead : zéros explicites et conversionRate null (jamais NaN)', async () => {
    const figures = await service.getLeadFunnelAggregates({ campusId: CAMPUS });
    expect(figures.totalLeads).toBe(0);
    expect(figures.enrolledLeads).toBe(0);
    expect(figures.conversionRate).toBeNull();
    expect(figures.byStatus).toEqual({});
    expect(figures.fraudFlags).toEqual({});
    expect(figures.weeklyNewLeads).toHaveLength(8);
  });
});
