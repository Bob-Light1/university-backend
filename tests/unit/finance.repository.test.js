'use strict';

/**
 * Couche repository — module finance (R1).
 * Verrouille le contrat de finance.repository. Le model Income est mocké (sans DB).
 */

// The repository derives its not-deleted filter from each schema, so the mocks carry one.
const stubbed = (modelName, marker, statics) => ({
  modelName,
  schema: require('../helpers/soft-delete-stub').softDeleteSchemaStub(marker),
  ...statics,
});

jest.mock('../../modules/finance/models/income.model', () => stubbed('Income', 'isDeleted', {
  countDocuments: jest.fn().mockResolvedValue(7),
}));
jest.mock('../../modules/finance/models/expense.model', () => stubbed('Expense', 'isDeleted', {}));
jest.mock('../../modules/finance/models/expense-category.model', () => stubbed('ExpenseCategory', 'isDeleted', {}));
jest.mock('../../modules/finance/models/studentFee.model', () => stubbed('StudentFee', 'isDeleted', {}));

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
