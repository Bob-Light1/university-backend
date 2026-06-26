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

const repo = require('../../modules/finance/finance.repository');
const { service: notification } = require('../../modules/notification');
const { service: studentService } = require('../../modules/student');
const finance = require('../../modules/finance/finance.service');

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
    expect(res).toEqual({ transitioned: 3, reminded: 2 });
  });

  test('une dette déjà relancée par une autre instance (claim → null) n\'est pas notifiée', async () => {
    repo.markPastDueOverdue.mockResolvedValue({ modifiedCount: 0 });
    repo.findRemindableOverdueFees.mockResolvedValue([{ _id: 'a' }, { _id: 'b' }]);
    repo.claimFeeForReminder.mockImplementation((id) => Promise.resolve(id === 'a' ? overdueFee(id) : null));

    const res = await finance.runOverdueJob();

    expect(notification.notify).toHaveBeenCalledTimes(1);
    expect(res.reminded).toBe(1);
  });

  test('aucune dette en retard → rien à faire', async () => {
    repo.markPastDueOverdue.mockResolvedValue({ modifiedCount: 0 });
    repo.findRemindableOverdueFees.mockResolvedValue([]);

    const res = await finance.runOverdueJob();

    expect(repo.claimFeeForReminder).not.toHaveBeenCalled();
    expect(notification.notify).not.toHaveBeenCalled();
    expect(res).toEqual({ transitioned: 0, reminded: 0 });
  });
});
