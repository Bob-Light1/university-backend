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
