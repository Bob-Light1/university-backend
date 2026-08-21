'use strict';

/**
 * Service — student payment tracking (finance.service).
 * Repository and notifications base mocked (no DB). We lock down
 * the orchestration: deposit guardrails, statement totals, reminder dispatch.
 */

jest.mock('../../modules/finance/finance.repository');
jest.mock('../../modules/notification', () => ({
  service: { notify: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../modules/student', () => ({
  service: {
    getStudentContact: jest.fn().mockResolvedValue({ email: 'stud@example.test' }),
    // Campus-membership guard for createFee — default to a match so the happy
    // paths create normally; individual tests override to simulate a miss.
    getStudentNamesByIds: jest.fn().mockResolvedValue([{ _id: 'stud-1' }]),
  },
}));
jest.mock('../../modules/settings', () => ({
  service: { getPreferredLanguage: jest.fn().mockResolvedValue('fr') },
}));
// The per-campus emission gate is pinned in tests/unit/entitlement.jobs.test.js;
// here we only assert that the job asks it and forwards its answer (§9.1).
jest.mock('../../shared/lib/entitlement', () => ({
  jobs: { suppressedCampusIds: jest.fn().mockResolvedValue([]) },
}));

const repo = require('../../modules/finance/finance.repository');
const { service: notification } = require('../../modules/notification');
const { service: studentService } = require('../../modules/student');
const finance = require('../../modules/finance/finance.service');
const { jobs: entitlementJobs } = require('../../shared/lib/entitlement');

// The balance notification is fire-and-forget + resolves the contact first (await):
// we let the microtask queue drain before asserting the call to notify.
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Builds a fake Mongoose fee document (mutable + save/toObject).
function fakeFeeDoc(over = {}) {
  const doc = {
    _id: 'fee-1',
    student: 'stud-1',
    schoolCampus: 'camp-1',
    amountDue: 100,
    amountPaid: 0,
    currency: 'XAF',
    dueDate: null,
    status: 'pending',
    ...over,
  };
  doc.save = jest.fn().mockResolvedValue(doc);
  doc.toObject = jest.fn(() => ({
    ...doc,
    balance: Math.max(0, doc.amountDue - doc.amountPaid),
    save: undefined,
    toObject: undefined,
  }));
  return doc;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('createFee', () => {
  test('crée la dette et notifie le solde dû (in-app)', async () => {
    repo.createFee.mockResolvedValue(fakeFeeDoc({ amountDue: 250 }));

    const fee = await finance.createFee({
      student: 'stud-1', schoolCampus: 'camp-1', label: 'Scolarité', amountDue: 250,
    });

    expect(repo.createFee).toHaveBeenCalled();
    expect(fee.balance).toBe(250);
    await flush();
    expect(notification.notify).toHaveBeenCalledWith(expect.objectContaining({
      template: 'payment.reminder',
      channels: ['inapp', 'email'],
      recipient: expect.objectContaining({ id: 'stud-1', model: 'Student', email: 'stud@example.test' }),
      data: expect.objectContaining({ amount: 250, currency: 'XAF' }),
      locale: 'fr',
    }));
  });

  test('un échec de notification ne fait pas échouer la création (fire-and-forget)', async () => {
    repo.createFee.mockResolvedValue(fakeFeeDoc());
    notification.notify.mockRejectedValueOnce(new Error('SMTP down'));
    await expect(finance.createFee({ student: 's', schoolCampus: 'c', label: 'x', amountDue: 100 }))
      .resolves.toBeDefined();
  });

  test('rejette (INVALID) un étudiant absent du campus de la dette', async () => {
    // No student matches the campus → cross-campus / unknown student.
    studentService.getStudentNamesByIds.mockResolvedValueOnce([]);
    await expect(
      finance.createFee({ student: 'other', schoolCampus: 'camp-1', label: 'x', amountDue: 100 }),
    ).rejects.toMatchObject({ code: 'INVALID' });
    expect(repo.createFee).not.toHaveBeenCalled();
  });
});

describe('recordPayment', () => {
  test('impute l\'acompte via un incrément atomique garanti et recalcule le statut', async () => {
    repo.getFeeDoc.mockResolvedValue(fakeFeeDoc({ amountDue: 100, amountPaid: 0 }));
    // Atomic guarded increment returns the post-update lean doc (balance virtual included).
    repo.incrementAmountPaidGuarded.mockResolvedValue({
      _id: 'fee-1', student: 'stud-1', schoolCampus: 'camp-1',
      amountDue: 100, amountPaid: 40, currency: 'XAF', dueDate: null, status: 'pending', balance: 60,
    });
    repo.setFeeStatus.mockResolvedValue({
      _id: 'fee-1', student: 'stud-1', schoolCampus: 'camp-1',
      amountDue: 100, amountPaid: 40, currency: 'XAF', dueDate: null, status: 'partial', balance: 60,
    });
    repo.createPayment.mockResolvedValue({ _id: 'pay-1', amount: 40, toObject: () => ({ _id: 'pay-1', amount: 40 }) });

    const { fee, payment } = await finance.recordPayment({
      feeId: 'fee-1', amount: 40, method: 'Cash', recordedBy: 'admin-1',
    });

    expect(repo.incrementAmountPaidGuarded).toHaveBeenCalledWith('fee-1', 40, {});
    expect(repo.createPayment).toHaveBeenCalledWith(expect.objectContaining({
      fee: 'fee-1', student: 'stud-1', schoolCampus: 'camp-1', amount: 40, currency: 'XAF', method: 'Cash',
    }));
    // amountPaid 40 < amountDue 100 → derived status moves pending → partial.
    expect(repo.setFeeStatus).toHaveBeenCalledWith('fee-1', 'partial');
    expect(fee.status).toBe('partial');
    expect(fee.balance).toBe(60);
    expect(payment._id).toBe('pay-1');
  });

  test('un solde concurrent modifié → INVALID, aucune ligne de paiement créée', async () => {
    repo.getFeeDoc.mockResolvedValue(fakeFeeDoc({ amountDue: 100, amountPaid: 0 }));
    repo.incrementAmountPaidGuarded.mockResolvedValue(null); // guard lost the race
    await expect(finance.recordPayment({ feeId: 'fee-1', amount: 40, method: 'Cash', recordedBy: 'a' }))
      .rejects.toMatchObject({ code: 'INVALID' });
    expect(repo.createPayment).not.toHaveBeenCalled();
  });

  test('refuse un surpaiement au-delà du solde restant', async () => {
    repo.getFeeDoc.mockResolvedValue(fakeFeeDoc({ amountDue: 100, amountPaid: 80 }));
    await expect(finance.recordPayment({ feeId: 'fee-1', amount: 50, method: 'Cash', recordedBy: 'a' }))
      .rejects.toMatchObject({ code: 'INVALID' });
    expect(repo.createPayment).not.toHaveBeenCalled();
  });

  test('refuse un montant nul ou négatif', async () => {
    repo.getFeeDoc.mockResolvedValue(fakeFeeDoc());
    await expect(finance.recordPayment({ feeId: 'fee-1', amount: 0, method: 'Cash', recordedBy: 'a' }))
      .rejects.toMatchObject({ code: 'INVALID' });
  });

  test('refuse de payer une dette annulée', async () => {
    repo.getFeeDoc.mockResolvedValue(fakeFeeDoc({ status: 'cancelled' }));
    await expect(finance.recordPayment({ feeId: 'fee-1', amount: 10, method: 'Cash', recordedBy: 'a' }))
      .rejects.toMatchObject({ code: 'INVALID' });
  });

  test('dette introuvable → NOT_FOUND', async () => {
    repo.getFeeDoc.mockResolvedValue(null);
    await expect(finance.recordPayment({ feeId: 'x', amount: 10, method: 'Cash', recordedBy: 'a' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('getStudentLedger', () => {
  test('agrège les totaux dû / réglé / solde', async () => {
    repo.findFeesByStudent.mockResolvedValue([
      { amountDue: 100, amountPaid: 40 },
      { amountDue: 200, amountPaid: 200 },
    ]);
    repo.findPaymentsByStudent.mockResolvedValue([{ amount: 40 }, { amount: 200 }]);

    const ledger = await finance.getStudentLedger('stud-1', { schoolCampus: 'camp-1' });

    expect(repo.findFeesByStudent).toHaveBeenCalledWith('stud-1', { schoolCampus: 'camp-1' });
    expect(ledger.totals).toEqual({ totalDue: 300, totalPaid: 240, balance: 60 });
    expect(ledger.payments).toHaveLength(2);
  });
});

describe('remindBalance', () => {
  test('notifie quand la dette existe', async () => {
    repo.findFeeById.mockResolvedValue({ student: 's', schoolCampus: 'c', amountDue: 100, amountPaid: 0, currency: 'XAF', balance: 100 });
    const fee = await finance.remindBalance('fee-1', {});
    expect(fee).toBeTruthy();
    expect(notification.notify).toHaveBeenCalledWith(expect.objectContaining({ template: 'payment.reminder' }));
  });

  test('ne notifie pas quand le solde est nul', async () => {
    repo.findFeeById.mockResolvedValue({ student: 's', schoolCampus: 'c', amountDue: 100, amountPaid: 100, currency: 'XAF', balance: 0 });
    await finance.remindBalance('fee-1', {});
    expect(notification.notify).not.toHaveBeenCalled();
  });

  test('dette introuvable → null, aucune notif', async () => {
    repo.findFeeById.mockResolvedValue(null);
    expect(await finance.remindBalance('x', {})).toBeNull();
    expect(notification.notify).not.toHaveBeenCalled();
  });

  test('relance manuelle horodate la cadence (touchReminded)', async () => {
    repo.findFeeById.mockResolvedValue({ student: 's', schoolCampus: 'c', amountDue: 100, amountPaid: 0, currency: 'XAF', balance: 100 });
    await finance.remindBalance('fee-1', {});
    expect(repo.touchReminded).toHaveBeenCalledWith('fee-1', expect.any(Date));
  });
});

describe('runOverdueJob', () => {
  beforeEach(() => entitlementJobs.suppressedCampusIds.mockResolvedValue([]));

  const overdueFee = (id) => ({
    _id: id, student: 's', schoolCampus: 'c',
    amountDue: 100, amountPaid: 0, currency: 'XAF', dueDate: new Date('2020-01-01'), balance: 100,
  });

  test('transitionne en masse puis relance chaque dette due (claim atomique)', async () => {
    repo.markPastDueOverdue.mockResolvedValue({ modifiedCount: 3 });
    repo.findRemindableOverdueFees.mockResolvedValue([{ _id: 'a' }, { _id: 'b' }]);
    repo.claimFeeForReminder.mockImplementation((id) => Promise.resolve(overdueFee(id)));

    const res = await finance.runOverdueJob();

    expect(repo.markPastDueOverdue).toHaveBeenCalledWith(expect.any(Date));
    expect(repo.claimFeeForReminder).toHaveBeenCalledWith('a', expect.any(Date), expect.any(Date));
    expect(repo.claimFeeForReminder).toHaveBeenCalledWith('b', expect.any(Date), expect.any(Date));
    expect(notification.notify).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ transitioned: 3, reminded: 2, suppressedCampuses: 0 });
  });

  test('une dette déjà relancée par une autre instance (claim → null) n\'est pas notifiée', async () => {
    repo.markPastDueOverdue.mockResolvedValue({ modifiedCount: 0 });
    repo.findRemindableOverdueFees.mockResolvedValue([{ _id: 'a' }, { _id: 'b' }]);
    repo.claimFeeForReminder.mockImplementation((id) => Promise.resolve(id === 'a' ? overdueFee(id) : null));

    const res = await finance.runOverdueJob();

    expect(notification.notify).toHaveBeenCalledTimes(1);
    expect(res.reminded).toBe(1);
  });

  test('les campus dont Finance est coupé sont exclus de la requête, pas après le claim', async () => {
    // Design doc §9.1. The exclusion has to reach the QUERY: `claimFeeForReminder`
    // stamps `lastRemindedAt` and bumps `reminderCount` on pickup, so a reminder
    // dropped afterwards would still burn the debt's dunning slot and leave it
    // un-remindable for a whole cadence window once the module came back.
    entitlementJobs.suppressedCampusIds.mockResolvedValue(['camp-off']);
    repo.markPastDueOverdue.mockResolvedValue({ modifiedCount: 2 });
    repo.findRemindableOverdueFees.mockResolvedValue([]);

    const res = await finance.runOverdueJob();

    expect(entitlementJobs.suppressedCampusIds).toHaveBeenCalledWith('finance');
    expect(repo.findRemindableOverdueFees).toHaveBeenCalledWith(
      expect.any(Date), expect.any(Number), { excludeCampusIds: ['camp-off'] },
    );
    // The transition is HYGIENE and still runs for everyone: a debt past its due
    // date is a fact about a date, and freezing it would leave a frozen ledger
    // showing `pending` on plainly overdue debts.
    expect(repo.markPastDueOverdue).toHaveBeenCalledWith(expect.any(Date));
    expect(res).toEqual({ transitioned: 2, reminded: 0, suppressedCampuses: 1 });
  });

  test('aucune dette en retard → rien à faire', async () => {
    repo.markPastDueOverdue.mockResolvedValue({ modifiedCount: 0 });
    repo.findRemindableOverdueFees.mockResolvedValue([]);

    const res = await finance.runOverdueJob();

    expect(repo.claimFeeForReminder).not.toHaveBeenCalled();
    expect(notification.notify).not.toHaveBeenCalled();
    expect(res).toEqual({ transitioned: 0, reminded: 0, suppressedCampuses: 0 });
  });
});

// ── AI advisor aggregates (M5b — design §6.5/§6.6) ───────────────────────────
// Non-regression on the FIGURES the advisors engine consumes: campus id cast
// to ObjectId (pipelines do not auto-cast — M5 real-boot lesson), zero-filled
// aging bands and a continuous monthly cashflow series (an empty month is an
// explicit zero, never a hole — the anomaly z-score needs even spacing).

const mongoose = require('mongoose');
const CAMPUS = 'f'.repeat(24);
const CAMPUS_OID = new mongoose.Types.ObjectId(CAMPUS);

describe('getOverdueAgingAggregates (M5b)', () => {
  test('campus casté ObjectId + date de référence fournie au pipeline', async () => {
    repo.aggregateOverdueAging.mockResolvedValue([]);
    await finance.getOverdueAgingAggregates({ campusId: CAMPUS });
    expect(repo.aggregateOverdueAging).toHaveBeenCalledWith(CAMPUS_OID, expect.any(Date));
  });

  test('bandes zéro-remplies, totaux dérivés, arrondi des rappels moyens', async () => {
    repo.aggregateOverdueAging.mockResolvedValue([
      { _id: 0, count: 10, outstanding: 500, avgReminderCount: 1.04 },
      { _id: 'over90', count: 3, outstanding: 200, avgReminderCount: 4.96 },
    ]);
    const figures = await finance.getOverdueAgingAggregates({ campusId: CAMPUS });
    expect(figures).toEqual({
      totalCount: 13,
      totalOutstanding: 700,
      buckets: [
        { band: '1-30', count: 10, outstanding: 500, avgReminderCount: 1 },
        { band: '31-60', count: 0, outstanding: 0, avgReminderCount: 0 },
        { band: '61-90', count: 0, outstanding: 0, avgReminderCount: 0 },
        { band: '90+', count: 3, outstanding: 200, avgReminderCount: 5 },
      ],
    });
  });

  test('campus sans impayé : structure stable, zéros explicites', async () => {
    repo.aggregateOverdueAging.mockResolvedValue([]);
    const figures = await finance.getOverdueAgingAggregates({ campusId: CAMPUS });
    expect(figures.totalCount).toBe(0);
    expect(figures.buckets).toHaveLength(4);
    expect(figures.buckets.every((b) => b.count === 0 && b.outstanding === 0)).toBe(true);
  });
});

describe('getMonthlyCashflowSeries (M5b)', () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-04T10:00:00Z'));
  });
  afterAll(() => jest.useRealTimers());

  beforeEach(() => {
    repo.monthlyIncomeTotals.mockResolvedValue([]);
    repo.monthlyExpenseTotals.mockResolvedValue([]);
  });

  test('série continue zéro-remplie, income/expense fusionnés par mois', async () => {
    repo.monthlyIncomeTotals.mockResolvedValue([
      { _id: { year: 2026, month: 7 }, total: 100 },
      { _id: { year: 2026, month: 5 }, total: 80 },
    ]);
    repo.monthlyExpenseTotals.mockResolvedValue([
      { _id: { year: 2026, month: 7 }, total: 60 },
    ]);
    const figures = await finance.getMonthlyCashflowSeries({ campusId: CAMPUS, months: '3' });
    expect(figures).toEqual({
      months: 3,
      series: [
        { year: 2026, month: 5, income: 80, expense: 0, net: 80 },
        { year: 2026, month: 6, income: 0, expense: 0, net: 0 },
        { year: 2026, month: 7, income: 100, expense: 60, net: 40 },
      ],
    });
  });

  test('scope : campus casté + borne (year, month) sur le couple dénormalisé', async () => {
    await finance.getMonthlyCashflowSeries({ campusId: CAMPUS, months: 3 });
    const match = repo.monthlyIncomeTotals.mock.calls[0][0];
    expect(match.schoolCampus).toEqual(CAMPUS_OID);
    expect(match.$or).toEqual([
      { year: { $gt: 2026 } },
      { year: 2026, month: { $gte: 5 } },
    ]);
    expect(repo.monthlyExpenseTotals).toHaveBeenCalledWith(match);
  });

  test('months borné [3, 24], 12 par défaut ou si invalide', async () => {
    const spans = [];
    for (const months of [undefined, 'abc', '1', '99']) {
      const { series } = await finance.getMonthlyCashflowSeries({ campusId: CAMPUS, months });
      spans.push(series.length);
    }
    expect(spans).toEqual([12, 12, 3, 24]);
  });

  test('la fenêtre traverse le passage d\'année sans trou', async () => {
    const { series } = await finance.getMonthlyCashflowSeries({ campusId: CAMPUS, months: 12 });
    expect(series[0]).toMatchObject({ year: 2025, month: 8 });
    expect(series[11]).toMatchObject({ year: 2026, month: 7 });
    expect(series).toHaveLength(12);
  });
});
