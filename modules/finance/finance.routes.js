'use strict';

/**
 * @file finance.routes.js — finance routes (mounted on /api/finance).
 *
 * /my/ledger             → the student views their own ledger (STUDENT).
 * /fees, /fees/:id…      → student debts + payments (management).
 * /students/:id/ledger   → a student's ledger (management).
 * /summary               → income vs expense summary (management).
 * /expense-categories…   → expense category CRUD (management).
 * /expenses, /expenses/… → expense CRUD + approval workflow (management).
 * /incomes, /incomes/…   → income CRUD (management).
 *
 * Management roles: ADMIN / DIRECTOR / CAMPUS_MANAGER.
 */

const express = require('express');
const router  = express.Router();

const ctrl        = require('./controllers/finance.controller');
const expenseCtrl = require('./controllers/expense.controller');
const incomeCtrl  = require('./controllers/income.controller');
const { authenticate, authorize } = require('../../shared/middleware/auth');
const { apiLimiter } = require('../../shared/middleware/rate-limiter');

const MGMT_ROLES = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];

router.use(authenticate);

// ── Student: their ledger (before /fees to avoid any collision) ───────────────
/**
 * @route GET /api/finance/my/ledger
 * @desc  Ledger (debts + payments + totals) of the current student
 * @access STUDENT
 */
router.get('/my/ledger', authorize(['STUDENT']), apiLimiter, ctrl.getMyLedger);

// ── Debt management ───────────────────────────────────────────────────────────
/**
 * @route POST /api/finance/fees
 * @desc  Creates a debt for a student (notifies the balance in-app)
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.post('/fees', authorize(MGMT_ROLES), apiLimiter, ctrl.createFee);

/**
 * @route GET /api/finance/fees
 * @desc  Paginated list of debts (filters status/student/academicYear), campus-scoped
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.get('/fees', authorize(MGMT_ROLES), apiLimiter, ctrl.listFees);

/**
 * @route GET /api/finance/fees/:id
 * @desc  A debt and its payments
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.get('/fees/:id', authorize(MGMT_ROLES), apiLimiter, ctrl.getFee);

/**
 * @route POST /api/finance/fees/:id/payments
 * @desc  Applies a payment to a debt
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.post('/fees/:id/payments', authorize(MGMT_ROLES), apiLimiter, ctrl.recordPayment);

/**
 * @route POST /api/finance/fees/:id/remind
 * @desc  (Re)sends a balance reminder to the student
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.post('/fees/:id/remind', authorize(MGMT_ROLES), apiLimiter, ctrl.remindBalance);

/**
 * @route DELETE /api/finance/fees/:id
 * @desc  Soft-delete of a debt
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.delete('/fees/:id', authorize(MGMT_ROLES), apiLimiter, ctrl.deleteFee);

/**
 * @route GET /api/finance/students/:studentId/ledger
 * @desc  Ledger of a given student (campus-scoped)
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.get('/students/:studentId/ledger', authorize(MGMT_ROLES), apiLimiter, ctrl.getStudentLedger);

// ── Financial summary ───────────────────────────────────────────────────────
/**
 * @route GET /api/finance/summary
 * @desc  Received income vs paid expenses and the net, campus-scoped (filters year/month)
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.get('/summary', authorize(MGMT_ROLES), apiLimiter, ctrl.getSummary);

// ── Expense categories (named routes before any /:id) ─────────────────────────
/**
 * @route GET /api/finance/expense-categories
 * @desc  List of expense categories
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.get('/expense-categories', authorize(MGMT_ROLES), apiLimiter, expenseCtrl.listCategories);
/**
 * @route POST /api/finance/expense-categories
 * @desc  Create an expense category
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.post('/expense-categories', authorize(MGMT_ROLES), apiLimiter, expenseCtrl.createCategory);
/**
 * @route DELETE /api/finance/expense-categories/:id
 * @desc  Soft-delete an expense category (refused if still in use)
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.delete('/expense-categories/:id', authorize(MGMT_ROLES), apiLimiter, expenseCtrl.deleteCategory);

// ── Expenses ──────────────────────────────────────────────────────────────────
/**
 * @route POST /api/finance/expenses
 * @desc  Create an expense (status pending)
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.post('/expenses', authorize(MGMT_ROLES), apiLimiter, expenseCtrl.createExpense);
/**
 * @route GET /api/finance/expenses
 * @desc  Paginated list of expenses (filters status/category/year/month), campus-scoped
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.get('/expenses', authorize(MGMT_ROLES), apiLimiter, expenseCtrl.listExpenses);
/**
 * @route GET /api/finance/expenses/:id
 * @desc  A single expense
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.get('/expenses/:id', authorize(MGMT_ROLES), apiLimiter, expenseCtrl.getExpense);
/**
 * @route PATCH /api/finance/expenses/:id
 * @desc  Update a non-paid expense
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.patch('/expenses/:id', authorize(MGMT_ROLES), apiLimiter, expenseCtrl.updateExpense);
/**
 * @route POST /api/finance/expenses/:id/approve
 * @desc  Approve a pending expense
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.post('/expenses/:id/approve', authorize(MGMT_ROLES), apiLimiter, expenseCtrl.approveExpense);
/**
 * @route POST /api/finance/expenses/:id/reject
 * @desc  Reject a pending or approved expense
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.post('/expenses/:id/reject', authorize(MGMT_ROLES), apiLimiter, expenseCtrl.rejectExpense);
/**
 * @route POST /api/finance/expenses/:id/pay
 * @desc  Mark an approved expense as paid
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.post('/expenses/:id/pay', authorize(MGMT_ROLES), apiLimiter, expenseCtrl.payExpense);
/**
 * @route DELETE /api/finance/expenses/:id
 * @desc  Soft-delete an expense
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.delete('/expenses/:id', authorize(MGMT_ROLES), apiLimiter, expenseCtrl.deleteExpense);

// ── Incomes ─────────────────────────────────────────────────────────────────
/**
 * @route POST /api/finance/incomes
 * @desc  Create an income record
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.post('/incomes', authorize(MGMT_ROLES), apiLimiter, incomeCtrl.createIncome);
/**
 * @route GET /api/finance/incomes
 * @desc  Paginated list of incomes (filters source/status/year/month/student), campus-scoped
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.get('/incomes', authorize(MGMT_ROLES), apiLimiter, incomeCtrl.listIncomes);
/**
 * @route GET /api/finance/incomes/:id
 * @desc  A single income
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.get('/incomes/:id', authorize(MGMT_ROLES), apiLimiter, incomeCtrl.getIncome);
/**
 * @route PATCH /api/finance/incomes/:id
 * @desc  Update an income
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.patch('/incomes/:id', authorize(MGMT_ROLES), apiLimiter, incomeCtrl.updateIncome);
/**
 * @route DELETE /api/finance/incomes/:id
 * @desc  Soft-delete an income
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
router.delete('/incomes/:id', authorize(MGMT_ROLES), apiLimiter, incomeCtrl.deleteIncome);

module.exports = router;
