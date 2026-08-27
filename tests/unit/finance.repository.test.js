'use strict';

/**
 * Couche repository — module finance (R1).
 * Verrouille le contrat de finance.repository. Les models sont mockés (sans DB) ;
 * les chemins que ces filtres nomment sont, eux, vérifiés contre les schémas
 * réels dans `fee-reminder-kind.test.js` — un filtre sur un chemin inexistant ne
 * lève rien, il ne sélectionne rien.
 */

// The repository derives its not-deleted filter from each schema, so the mocks carry one.
const stubbed = (modelName, marker, statics) => ({
  modelName,
  schema: require('../helpers/soft-delete-stub').softDeleteSchemaStub(marker),
  ...statics,
});

/** find().sort().limit().select().lean() — the read chain of the sweeps. */
const makeChain = (result) => {
  const q = {};
  q.sort   = jest.fn(() => q);
  q.skip   = jest.fn(() => q);
  q.limit  = jest.fn(() => q);
  q.select = jest.fn(() => q);
  q.populate = jest.fn(() => q);
  q.lean   = jest.fn().mockResolvedValue(result);
  return q;
};

jest.mock('../../modules/finance/models/income.model', () => stubbed('Income', 'isDeleted', {
  countDocuments: jest.fn().mockResolvedValue(7),
}));
jest.mock('../../modules/finance/models/expense.model', () => stubbed('Expense', 'isDeleted', {}));
jest.mock('../../modules/finance/models/expense-category.model', () => stubbed('ExpenseCategory', 'isDeleted', {}));
jest.mock('../../modules/finance/models/studentFee.model', () => stubbed('StudentFee', 'isDeleted', {
  find: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));
jest.mock('../../modules/finance/models/feePayment.model', () => ({
  modelName: 'FeePayment',
  findOne: jest.fn(),
}));

const Income     = require('../../modules/finance/models/income.model');
const StudentFee = require('../../modules/finance/models/studentFee.model');
const FeePayment = require('../../modules/finance/models/feePayment.model');
const repo = require('../../modules/finance/finance.repository');
const { REMINDER_KINDS } = require('../../modules/finance/fee-reminder-kind');

const CAMPUS = 'aaaaaaaaaaaaaaaaaaaaaaaa';

beforeEach(() => jest.clearAllMocks());

describe('countByCampusAndStatus', () => {
  test('compte les income filtrés par campus + statut', async () => {
    const n = await repo.countByCampusAndStatus('campus-1', 'pending');
    expect(Income.countDocuments).toHaveBeenCalledWith({ schoolCampus: 'campus-1', status: 'pending', isDeleted: false });
    expect(n).toBe(7);
  });
});

// ── Pre-due cadence (design note §6, §9③, §9⑦) ───────────────────────────────

describe('findFeesDueSoon', () => {
  const FROM = new Date('2026-06-15T00:00:00.000Z');
  const TO   = new Date('2026-06-23T00:00:00.000Z');

  const run = (over = {}) => {
    StudentFee.find.mockReturnValue(makeChain([{ _id: 'fee-1', dueDate: FROM }]));
    return repo.findFeesDueSoon({ from: FROM, to: TO, ...over });
  };

  test('ne lit que les dettes vivantes, non soldées, dont l\'échéance tombe dans la fenêtre', async () => {
    await run();
    expect(StudentFee.find).toHaveBeenCalledWith({
      isDeleted: false, // derived from the schema, never hand-written (§5.1)
      status: { $in: ['pending', 'partial'] },
      dueDate: { $gte: FROM, $lt: TO },
      $expr: { $lt: ['$amountPaid', '$amountDue'] },
    });
  });

  test('pagine par _id croissant, jamais par skip (§9⑦)', async () => {
    // Claiming a debt does NOT remove it from the window — it stays there until
    // it falls due. A `skip` loop would re-read the same page forever.
    const chain = makeChain([]);
    StudentFee.find.mockReturnValue(chain);
    await repo.findFeesDueSoon({ from: FROM, to: TO, afterId: 'fee-9', limit: 50 });

    expect(StudentFee.find.mock.calls[0][0]).toMatchObject({ _id: { $gt: 'fee-9' } });
    expect(chain.sort).toHaveBeenCalledWith({ _id: 1 });
    expect(chain.skip).not.toHaveBeenCalled();
    expect(chain.limit).toHaveBeenCalledWith(50);
    expect(chain.select).toHaveBeenCalledWith('_id dueDate');
    expect(chain.lean).toHaveBeenCalled();
  });

  test('la première page ne borne pas _id', async () => {
    await run();
    expect(StudentFee.find.mock.calls[0][0]._id).toBeUndefined();
  });

  test('les campus dont Finance est coupé sont exclus DANS la requête (§9③)', async () => {
    // Not after the claim: the claim stamps the marker on pickup, so a debt
    // dropped afterwards would burn its one notice of that kind for good and
    // stay silent even once the module came back.
    await run({ excludeCampusIds: [CAMPUS] });
    expect(StudentFee.find.mock.calls[0][0]).toMatchObject({
      schoolCampus: { $nin: [CAMPUS] },
    });
  });

  test('sans campus suspendu, aucun $nin n\'est ajouté', async () => {
    await run({ excludeCampusIds: [] });
    expect(StudentFee.find.mock.calls[0][0].schoolCampus).toBeUndefined();
  });
});

describe('claimFeeForPreDueReminder', () => {
  const NOW = new Date('2026-06-15T07:00:00.000Z');

  const claim = (kind = REMINDER_KINDS.DUE_IN_3D) => {
    const p = Promise.resolve({ _id: 'fee-1' });
    p.lean = jest.fn().mockResolvedValue({ _id: 'fee-1', balance: 100 });
    StudentFee.findOneAndUpdate.mockReturnValue(p);
    return repo.claimFeeForPreDueReminder('fee-1', kind, NOW);
  };

  test('réclame un type au plus une fois : garde $ne + $push', async () => {
    await claim();
    const [filter, update, options] = StudentFee.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({
      _id: 'fee-1',
      status: { $in: ['pending', 'partial'] },
      'remindersSent.kind': { $ne: 'due_in_3d' },
    });
    expect(update).toEqual({ $push: { remindersSent: { kind: 'due_in_3d', sentAt: NOW } } });
    expect(options).toEqual({ new: true });
  });

  test('LE piège du §6 : la réclamation avant échéance n\'écrit NI lastRemindedAt NI reminderCount', async () => {
    // Writing either would drop the debt out of `claimFeeForReminder`'s window
    // (`lastRemindedAt < cutoff`) on the very day it falls past due — the debt
    // would skip its overdue reminder *because* the pre-due one worked.
    await claim();
    const [filter, update] = StudentFee.findOneAndUpdate.mock.calls[0];
    expect(JSON.stringify(update)).not.toContain('lastRemindedAt');
    expect(JSON.stringify(update)).not.toContain('reminderCount');
    expect(update.$set).toBeUndefined();
    expect(update.$inc).toBeUndefined();
    // …and symmetrically, it does not read them either: the two cadences share
    // no field in either direction.
    expect(JSON.stringify(filter)).not.toContain('lastRemindedAt');
  });

  test('la garde matche une dette écrite avant le champ (aucune migration — §9②)', async () => {
    // `remindersSent.kind: { $ne }` matches a document that has no such path at
    // all, which is why a legacy debt enters the cadence with no script run.
    await claim();
    const [filter] = StudentFee.findOneAndUpdate.mock.calls[0];
    expect(filter['remindersSent.kind']).toEqual({ $ne: 'due_in_3d' });
    expect(filter['remindersSent.kind'].$exists).toBeUndefined();
  });

  test('chaque type porte sa propre garde — un type n\'en bloque pas un autre', async () => {
    await claim(REMINDER_KINDS.DUE_IN_7D);
    await claim(REMINDER_KINDS.DUE_TODAY);
    expect(StudentFee.findOneAndUpdate.mock.calls[0][0]['remindersSent.kind']).toEqual({ $ne: 'due_in_7d' });
    expect(StudentFee.findOneAndUpdate.mock.calls[1][0]['remindersSent.kind']).toEqual({ $ne: 'due_today' });
  });
});

describe('la cadence d\'impayé reste intacte (l\'autre moitié du §6)', () => {
  test('claimFeeForReminder ne consulte jamais remindersSent', async () => {
    const p = Promise.resolve(null);
    p.lean = jest.fn().mockResolvedValue(null);
    StudentFee.findOneAndUpdate.mockReturnValue(p);
    await repo.claimFeeForReminder('fee-1', new Date('2026-06-10'), new Date('2026-06-15'));

    const [filter, update] = StudentFee.findOneAndUpdate.mock.calls[0];
    expect(JSON.stringify(filter)).not.toContain('remindersSent');
    expect(JSON.stringify(update)).not.toContain('remindersSent');
    // It still claims on its own two markers, untouched by the additive change.
    expect(update).toEqual({
      $set: { lastRemindedAt: new Date('2026-06-15') },
      $inc: { reminderCount: 1 },
    });
  });

  test('findRemindableOverdueFees ne consulte jamais remindersSent non plus', async () => {
    StudentFee.find.mockReturnValue(makeChain([]));
    await repo.findRemindableOverdueFees(new Date('2026-06-10'), 200, {});
    expect(JSON.stringify(StudentFee.find.mock.calls[0][0])).not.toContain('remindersSent');
  });
});

// ── Receipt (design note §2, §3) ─────────────────────────────────────────────

describe('findPaymentById', () => {
  const chainOf = (result) => {
    const q = {};
    q.populate = jest.fn(() => q);
    q.lean = jest.fn().mockResolvedValue(result);
    return q;
  };

  test('applique la portée DANS la requête et peuple ce que le reçu imprime', async () => {
    const chain = chainOf({ _id: 'pay-1' });
    FeePayment.findOne.mockReturnValue(chain);

    const payment = await repo.findPaymentById('pay-1', { schoolCampus: CAMPUS, student: 'stud-1' });

    expect(FeePayment.findOne).toHaveBeenCalledWith({
      _id: 'pay-1', schoolCampus: CAMPUS, student: 'stud-1',
    });
    expect(chain.populate).toHaveBeenNthCalledWith(1, 'student', 'firstName lastName matricule');
    expect(chain.populate).toHaveBeenNthCalledWith(2, 'fee', expect.stringContaining('amountDue'));
    expect(payment).toEqual({ _id: 'pay-1' });
  });

  test('hors portée : la requête ne rend rien — la ligne n\'est pas lue puis écartée', async () => {
    // Filtering after the read is what turns a 404 into a confirmation that the
    // id exists; the scope has to be part of the query.
    FeePayment.findOne.mockReturnValue(chainOf(null));
    expect(await repo.findPaymentById('pay-1', { schoolCampus: CAMPUS })).toBeNull();
    expect(FeePayment.findOne.mock.calls[0][0].schoolCampus).toBe(CAMPUS);
  });
});
