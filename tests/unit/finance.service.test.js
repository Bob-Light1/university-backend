'use strict';

/**
 * Service — suivi paiement étudiant (finance.service).
 * Repository et socle notifications mockés (sans DB). On verrouille
 * l'orchestration : garde-fous d'acompte, totaux du relevé, émission du rappel.
 */

jest.mock('../../modules/finance/finance.repository');
jest.mock('../../modules/notification', () => ({
  service: { notify: jest.fn().mockResolvedValue([]) },
}));

const repo = require('../../modules/finance/finance.repository');
const { service: notification } = require('../../modules/notification');
const finance = require('../../modules/finance/finance.service');

// Fabrique un faux document Mongoose de dette (mutable + save/toObject).
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
    expect(notification.notify).toHaveBeenCalledWith(expect.objectContaining({
      template: 'payment.reminder',
      channels: ['inapp'],
      recipient: expect.objectContaining({ id: 'stud-1', model: 'Student' }),
      data: expect.objectContaining({ amount: 250, currency: 'XAF' }),
    }));
  });

  test('un échec de notification ne fait pas échouer la création (fire-and-forget)', async () => {
    repo.createFee.mockResolvedValue(fakeFeeDoc());
    notification.notify.mockRejectedValueOnce(new Error('SMTP down'));
    await expect(finance.createFee({ student: 's', schoolCampus: 'c', label: 'x', amountDue: 100 }))
      .resolves.toBeDefined();
  });
});

describe('recordPayment', () => {
  test('impute l\'acompte, met à jour amountPaid et sauvegarde', async () => {
    const doc = fakeFeeDoc({ amountDue: 100, amountPaid: 0 });
    repo.getFeeDoc.mockResolvedValue(doc);
    repo.createPayment.mockResolvedValue({ _id: 'pay-1', amount: 40, toObject: () => ({ _id: 'pay-1', amount: 40 }) });

    const { fee, payment } = await finance.recordPayment({
      feeId: 'fee-1', amount: 40, method: 'Cash', recordedBy: 'admin-1',
    });

    expect(repo.createPayment).toHaveBeenCalledWith(expect.objectContaining({
      fee: 'fee-1', student: 'stud-1', schoolCampus: 'camp-1', amount: 40, currency: 'XAF', method: 'Cash',
    }));
    expect(doc.amountPaid).toBe(40);
    expect(doc.save).toHaveBeenCalled();
    expect(fee.balance).toBe(60);
    expect(payment._id).toBe('pay-1');
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
});
