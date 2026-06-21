'use strict';

/**
 * Couche repository — module finance (R1).
 * Verrouille le contrat de finance.repository. Le model Income est mocké (sans DB).
 */

jest.mock('../../modules/finance/models/income.model', () => ({
  countDocuments: jest.fn().mockResolvedValue(7),
}));

const Income = require('../../modules/finance/models/income.model');
const repo = require('../../modules/finance/finance.repository');

beforeEach(() => Income.countDocuments.mockClear());

describe('countByCampusAndStatus', () => {
  test('compte les income filtrés par campus + statut', async () => {
    const n = await repo.countByCampusAndStatus('campus-1', 'pending');
    expect(Income.countDocuments).toHaveBeenCalledWith({ schoolCampus: 'campus-1', status: 'pending', isDeleted: false });
    expect(n).toBe(7);
  });
});
