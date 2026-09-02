'use strict';

/**
 * Règle pure de statut d'une dette étudiant (fee-status.js).
 * Précédence : cancelled > paid > overdue > partial > pending.
 */

const { computeStatus, STATUSES } = require('../../modules/finance/fee-status');

const PAST   = new Date('2020-01-01');
const FUTURE = new Date('2999-01-01');
const NOW    = new Date('2026-06-17');

describe('computeStatus', () => {
  test('expose les 5 statuts', () => {
    expect(STATUSES).toEqual(['pending', 'partial', 'paid', 'overdue', 'cancelled']);
  });

  test('cancelled est figé (jamais recalculé)', () => {
    expect(computeStatus({ amountDue: 100, amountPaid: 0, status: 'cancelled' }, NOW)).toBe('cancelled');
  });

  test('paid quand le montant est entièrement réglé', () => {
    expect(computeStatus({ amountDue: 100, amountPaid: 100, dueDate: PAST }, NOW)).toBe('paid');
    expect(computeStatus({ amountDue: 100, amountPaid: 150 }, NOW)).toBe('paid');
  });

  test('dette à 0 considérée soldée', () => {
    expect(computeStatus({ amountDue: 0, amountPaid: 0 }, NOW)).toBe('paid');
  });

  test('overdue quand un solde subsiste et l\'échéance est dépassée', () => {
    expect(computeStatus({ amountDue: 100, amountPaid: 0, dueDate: PAST }, NOW)).toBe('overdue');
    expect(computeStatus({ amountDue: 100, amountPaid: 40, dueDate: PAST }, NOW)).toBe('overdue');
  });

  test('partial quand un acompte est versé sans échéance dépassée', () => {
    expect(computeStatus({ amountDue: 100, amountPaid: 40, dueDate: FUTURE }, NOW)).toBe('partial');
    expect(computeStatus({ amountDue: 100, amountPaid: 40 }, NOW)).toBe('partial');
  });

  test('pending quand rien n\'est versé et pas encore échu', () => {
    expect(computeStatus({ amountDue: 100, amountPaid: 0, dueDate: FUTURE }, NOW)).toBe('pending');
    expect(computeStatus({ amountDue: 100, amountPaid: 0 }, NOW)).toBe('pending');
  });

  test('paid l\'emporte sur overdue (réglé mais échéance passée)', () => {
    expect(computeStatus({ amountDue: 100, amountPaid: 100, dueDate: PAST }, NOW)).toBe('paid');
  });
});

// ── The due day belongs to the debtor (design note §9⑰) ──────────────────────
//
// A debt is late once its due DAY has passed, not once its due INSTANT has. The
// distinction is invisible until two rules read the same debt on the same day:
// the 06:00 sweep, which transitions it, and the 07:00 pre-due sweep, which owes
// it a `due_today` notice. Reading `dueDate` as an instant made the first hide
// the debt from the second, and one third of the cadence never fired.
describe('la journée d\'échéance appartient encore au débiteur', () => {
  // What `<input type="date">` sends, and therefore what every fee created
  // through the ERP form carries.
  const DUE = new Date('2026-06-17T00:00:00.000Z');
  const unpaid = { amountDue: 100, amountPaid: 0, dueDate: DUE };

  test('à 06:00 le jour même, la dette n\'est pas encore en retard', () => {
    expect(computeStatus(unpaid, new Date('2026-06-17T06:00:00.000Z'))).toBe('pending');
  });

  test('à 23:59 le jour même non plus', () => {
    expect(computeStatus(unpaid, new Date('2026-06-17T23:59:59.999Z'))).toBe('pending');
  });

  test('elle bascule à minuit le lendemain, pas avant', () => {
    expect(computeStatus(unpaid, new Date('2026-06-18T00:00:00.000Z'))).toBe('overdue');
  });

  test('un acompte le jour même laisse partial, pas overdue', () => {
    expect(computeStatus({ ...unpaid, amountPaid: 40 }, new Date('2026-06-17T06:00:00.000Z'))).toBe('partial');
  });

  test('une échéance horodatée en cours de journée suit la même règle', () => {
    // The fixture anchors at 09:00; production data does not. Both must agree.
    const midDay = { ...unpaid, dueDate: new Date('2026-06-17T09:00:00.000Z') };
    expect(computeStatus(midDay, new Date('2026-06-17T06:00:00.000Z'))).toBe('pending');
    expect(computeStatus(midDay, new Date('2026-06-17T23:00:00.000Z'))).toBe('pending');
    expect(computeStatus(midDay, new Date('2026-06-18T00:00:00.000Z'))).toBe('overdue');
  });
});
