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
    getStudentContact: jest.fn().mockResolvedValue({ firstName: 'Ada', email: 'stud@example.test' }),
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
// The receipt borrows academic-print's PDF pool through its facade — one browser
// for the whole process (design note §9④). Mocked here: a real render would
// launch Chrome.
jest.mock('../../modules/academic-print', () => ({
  service: {
    renderPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
    getCampusBranding: jest.fn().mockResolvedValue({ campus_name: 'Campus A' }),
  },
}));

const repo = require('../../modules/finance/finance.repository');
const { service: notification } = require('../../modules/notification');
const { service: studentService } = require('../../modules/student');
const { service: settingsService } = require('../../modules/settings');
const { service: academicPrint } = require('../../modules/academic-print');
const finance = require('../../modules/finance/finance.service');
const { jobs: entitlementJobs } = require('../../shared/lib/entitlement');
const { REMINDER_KINDS } = require('../../modules/finance/fee-reminder-kind');

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

// ── Pre-due cadence (design note §6, §9③, §9⑦) ───────────────────────────────

describe('runDueSoonJob', () => {
  const DAY = 86400000;
  const NOW = new Date('2026-06-15T07:00:00.000Z');
  /** A debt row as the sweep reads it: id + due date, nothing else. */
  const dueIn = (id, days) => ({ _id: id, dueDate: new Date(NOW.getTime() + days * DAY) });
  const claimed = (id) => ({
    _id: id, student: 'stud-1', schoolCampus: 'camp-1',
    amountDue: 100, amountPaid: 0, currency: 'XAF', balance: 100,
  });

  beforeEach(() => {
    // The clock is frozen so the window and each debt's kind are deterministic,
    // but `setImmediate` stays real: `flush()` drains the fire-and-forget sends.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] }).setSystemTime(NOW);
    entitlementJobs.suppressedCampusIds.mockResolvedValue([]);
    repo.claimFeeForPreDueReminder.mockImplementation((id) => Promise.resolve(claimed(id)));
  });
  afterEach(() => jest.useRealTimers());

  test('relance chaque dette avec le type calculé depuis SA propre échéance', async () => {
    repo.findFeesDueSoon.mockResolvedValueOnce([dueIn('a', 7), dueIn('b', 3), dueIn('c', 0)]);

    const res = await finance.runDueSoonJob();
    await flush();

    expect(repo.claimFeeForPreDueReminder).toHaveBeenCalledWith('a', REMINDER_KINDS.DUE_IN_7D, expect.any(Date));
    expect(repo.claimFeeForPreDueReminder).toHaveBeenCalledWith('b', REMINDER_KINDS.DUE_IN_3D, expect.any(Date));
    expect(repo.claimFeeForPreDueReminder).toHaveBeenCalledWith('c', REMINDER_KINDS.DUE_TODAY, expect.any(Date));
    expect(res).toEqual({ reminded: 3, suppressedCampuses: 0 });
  });

  test('le gabarit dérive du type, jamais épelé au point d\'appel', async () => {
    repo.findFeesDueSoon.mockResolvedValueOnce([dueIn('b', 3)]);

    await finance.runDueSoonJob();
    await flush();

    expect(notification.notify).toHaveBeenCalledWith(expect.objectContaining({
      template: 'payment.due_in_3d',
      channels: ['inapp', 'email'],
      recipient: expect.objectContaining({ id: 'stud-1', model: 'Student' }),
      data: expect.objectContaining({ amount: 100, currency: 'XAF' }),
      locale: 'fr', // the STUDENT's language, from UserPreferences
    }));
  });

  test('la fenêtre lue est celle de la cadence, pas une durée redite', async () => {
    repo.findFeesDueSoon.mockResolvedValueOnce([]);
    await finance.runDueSoonJob();

    const { from, to } = repo.findFeesDueSoon.mock.calls[0][0];
    expect(from.toISOString()).toBe('2026-06-15T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-06-23T00:00:00.000Z');
  });

  test('une dette déjà relancée pour ce type (claim → null) n\'est pas notifiée', async () => {
    repo.findFeesDueSoon.mockResolvedValueOnce([dueIn('a', 7), dueIn('b', 7)]);
    repo.claimFeeForPreDueReminder.mockImplementation((id) =>
      Promise.resolve(id === 'a' ? claimed(id) : null));

    const res = await finance.runDueSoonJob();
    await flush();

    expect(notification.notify).toHaveBeenCalledTimes(1);
    expect(res.reminded).toBe(1);
  });

  test('une dette hors cadence n\'est même pas réclamée', async () => {
    // Guards against a query widened later: the rule, not the filter, decides.
    repo.findFeesDueSoon.mockResolvedValueOnce([dueIn('past', -1), dueIn('far', 30)]);

    const res = await finance.runDueSoonJob();
    await flush();

    expect(repo.claimFeeForPreDueReminder).not.toHaveBeenCalled();
    expect(notification.notify).not.toHaveBeenCalled();
    expect(res.reminded).toBe(0);
  });

  test('pagination par _id : la page suivante repart du dernier id, jamais d\'un skip (§9⑦)', async () => {
    // Claiming does not remove a debt from the window, so the candidate set does
    // NOT shrink between pages — a skip-based loop would re-read page 1 forever.
    const page1 = Array.from({ length: 200 }, (_, i) => dueIn(`fee-${i}`, 7));
    repo.findFeesDueSoon
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce([dueIn('fee-200', 7)]);

    const res = await finance.runDueSoonJob();
    await flush();

    expect(repo.findFeesDueSoon).toHaveBeenCalledTimes(2);
    expect(repo.findFeesDueSoon.mock.calls[0][0].afterId).toBeNull();
    expect(repo.findFeesDueSoon.mock.calls[1][0].afterId).toBe('fee-199');
    expect(repo.findFeesDueSoon.mock.calls[1][0]).not.toHaveProperty('skip');
    expect(res.reminded).toBe(201);
  });

  test('une page vide arrête le balayage', async () => {
    repo.findFeesDueSoon.mockResolvedValueOnce([]);
    await finance.runDueSoonJob();
    expect(repo.findFeesDueSoon).toHaveBeenCalledTimes(1);
  });

  test('les campus dont Finance est coupé sont exclus DANS la requête (§9③)', async () => {
    entitlementJobs.suppressedCampusIds.mockResolvedValue(['camp-off']);
    repo.findFeesDueSoon.mockResolvedValueOnce([]);

    const res = await finance.runDueSoonJob();

    expect(entitlementJobs.suppressedCampusIds).toHaveBeenCalledWith('finance');
    expect(repo.findFeesDueSoon.mock.calls[0][0].excludeCampusIds).toEqual(['camp-off']);
    // Unlike the overdue job there is no hygiene half to keep running: the whole
    // sweep is emission, so a silenced campus produces nothing at all.
    expect(res).toEqual({ reminded: 0, suppressedCampuses: 1 });
  });

  test('un échec d\'envoi ne casse pas le balayage (fire-and-forget)', async () => {
    repo.findFeesDueSoon.mockResolvedValueOnce([dueIn('a', 7)]);
    notification.notify.mockRejectedValueOnce(new Error('SMTP down'));
    await expect(finance.runDueSoonJob()).resolves.toEqual({ reminded: 1, suppressedCampuses: 0 });
  });
});

// ── What every fee notice carries (audit of step 7) ──────────────────────────
// One emitter feeds the overdue notice and the three pre-due ones, so a variable
// the catalog spells out and the emitter never passes is wrong in four places at
// once — and reads as a rendering glitch rather than as a missing field.

describe('les variables des gabarits de relance', () => {
  const fee = {
    student: 'stud-1', schoolCampus: 'camp-1',
    amountDue: 100, amountPaid: 0, currency: 'XAF', balance: 100,
    dueDate: new Date('2026-07-01T00:00:00.000Z'),
  };

  test('{name} est renseigné — sans lui, le courriel commence par « Bonjour , »', async () => {
    repo.findFeeById.mockResolvedValue(fee);
    await finance.remindBalance('fee-1', {});
    expect(notification.notify).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ name: 'Ada' }),
    }));
  });

  test('un étudiant sans prénom ne produit pas « undefined » dans le corps', async () => {
    studentService.getStudentContact.mockResolvedValueOnce({ email: 'x@y.z' });
    repo.findFeeById.mockResolvedValue(fee);
    await finance.remindBalance('fee-1', {});
    expect(notification.notify.mock.calls[0][0].data.name).toBe('');
  });

  test('{dueDate} est écrite dans la langue du destinataire, comme sur le reçu', async () => {
    // The student reads the reminder and the receipt of the same debt; an ISO
    // date in one and a long date in the other is the platform disagreeing with
    // itself about the same day.
    repo.findFeeById.mockResolvedValue(fee);
    await finance.remindBalance('fee-1', {});
    expect(notification.notify.mock.calls[0][0].data.dueDate).toBe('1 juillet 2026');
  });

  test('une dette sans échéance ne fabrique pas de fausse date', async () => {
    repo.findFeeById.mockResolvedValue({ ...fee, dueDate: null });
    await finance.remindBalance('fee-1', {});
    expect(notification.notify.mock.calls[0][0].data.dueDate).toBe('—');
  });

  test('les mêmes variables voyagent sur la cadence avant échéance', async () => {
    // Frozen three days before the due date, so the sweep has a kind to send.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
      .setSystemTime(new Date('2026-06-28T07:00:00.000Z'));
    entitlementJobs.suppressedCampusIds.mockResolvedValue([]);
    repo.findFeesDueSoon.mockResolvedValueOnce([{ _id: 'a', dueDate: fee.dueDate }]);
    repo.claimFeeForPreDueReminder.mockResolvedValue(fee);

    await finance.runDueSoonJob();
    await flush();
    jest.useRealTimers();

    expect(notification.notify).toHaveBeenCalledWith(expect.objectContaining({
      template: expect.stringMatching(/^payment\./),
      data: expect.objectContaining({ name: 'Ada', dueDate: '1 juillet 2026', amount: 100 }),
    }));
  });
});

// ── Payment receipt (design note §2, §3, §9④, §9⑥) ───────────────────────────

describe('getPaymentReceipt', () => {
  const PAYMENT = {
    _id: '507f1f77bcf86cd799439abc',
    schoolCampus: 'camp-1',
    student: { _id: 'stud-1', firstName: 'Ada', lastName: 'Lovelace', matricule: 'STU-A-001' },
    fee: { label: 'Tuition', academicYear: '2025-2026', amountDue: 150000, amountPaid: 50000, currency: 'XAF' },
    amount: 50000, currency: 'XAF', method: 'Cash', reference: 'PAY-A-001',
    paidAt: new Date('2026-06-01T10:00:00.000Z'),
  };

  test('rend le PDF par le pool partagé et nomme le reçu d\'après la référence', async () => {
    repo.findPaymentById.mockResolvedValue(PAYMENT);

    const receipt = await finance.getPaymentReceipt(PAYMENT._id, { schoolCampus: 'camp-1' });

    expect(academicPrint.renderPdf).toHaveBeenCalledTimes(1);
    expect(academicPrint.renderPdf).toHaveBeenCalledWith(
      expect.stringContaining('<!DOCTYPE html>'),
      expect.objectContaining({ format: 'A4' }),
    );
    expect(receipt.receiptNumber).toBe('PAY-A-001');
    expect(receipt.fileName).toBe('receipt-PAY-A-001.pdf');
    expect(Buffer.isBuffer(receipt.buffer)).toBe(true);
  });

  test('la portée du demandeur part telle quelle dans la requête', async () => {
    repo.findPaymentById.mockResolvedValue(PAYMENT);
    await finance.getPaymentReceipt('pay-1', { schoolCampus: 'camp-1', student: 'stud-1' });
    expect(repo.findPaymentById).toHaveBeenCalledWith('pay-1', { schoolCampus: 'camp-1', student: 'stud-1' });
  });

  test('hors portée : null, et aucun rendu lancé', async () => {
    repo.findPaymentById.mockResolvedValue(null);
    expect(await finance.getPaymentReceipt('pay-1', { schoolCampus: 'other' })).toBeNull();
    expect(academicPrint.renderPdf).not.toHaveBeenCalled();
  });

  test('la langue est celle de l\'ÉTUDIANT, pas celle du gestionnaire qui télécharge (§9⑥)', async () => {
    repo.findPaymentById.mockResolvedValue(PAYMENT);
    await finance.getPaymentReceipt(PAYMENT._id, { schoolCampus: 'camp-1' });
    expect(settingsService.getPreferredLanguage).toHaveBeenCalledWith('stud-1');
    // The branding is the payment's campus, not the caller's.
    expect(academicPrint.getCampusBranding).toHaveBeenCalledWith('camp-1');
  });

  test('sans référence saisie, le numéro dérive de l\'id — un rendu, pas un second compteur', async () => {
    repo.findPaymentById.mockResolvedValue({ ...PAYMENT, reference: undefined });
    const receipt = await finance.getPaymentReceipt(PAYMENT._id, {});
    expect(receipt.receiptNumber).toBe('PAY-99439ABC');
    // Stable: the same payment always prints the same string.
    const again = await finance.getPaymentReceipt(PAYMENT._id, {});
    expect(again.receiptNumber).toBe(receipt.receiptNumber);
  });

  test('le nom de fichier est assaini — la référence voyage dans un en-tête HTTP', async () => {
    // `reference` is operator-typed free text and lands in Content-Disposition:
    // a quote or a CR there is a header injection, not a cosmetic issue.
    repo.findPaymentById.mockResolvedValue({ ...PAYMENT, reference: 'PAY/2026 "A"\r\nX-Evil: 1' });
    const { fileName } = await finance.getPaymentReceipt(PAYMENT._id, {});
    expect(fileName).toBe('receipt-PAY-2026-A-X-Evil-1.pdf');
    expect(fileName).not.toMatch(/["\r\n]/);
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
