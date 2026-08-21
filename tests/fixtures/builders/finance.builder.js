'use strict';

/**
 * @file finance.builder.js
 * @description Money rows: expense categories, income, expenses, student fees and
 * the payments settling part of them.
 *
 * The overdue fees are computed against the frozen anchor, never against the wall
 * clock: the nightly overdue-fee cron and the "late payments" screens must render
 * the same figures in six months (§4.4).
 *
 * Fee statuses come from `modules/finance/fee-status.js`, the rule the model and
 * the service already share — restating it here would be a second source of truth
 * for the one thing the finance screens are read for (CLAUDE.md §0.1).
 */

const { oid, pad, stamps } = require('../ids');
const { COUNTS, CAMPUS_KEYS, ACADEMIC_YEAR, ANCHOR_DATE } = require('../seed.config');
const { computeStatus } = require('../../../modules/finance/fee-status');

const INCOME_SOURCES = ['Tuition', 'Enrollment Fees', 'Exam', 'Donation'];
const PAYMENT_METHODS = ['Cash', 'Mobile Money', 'Bank Transfer', 'Cheque'];

/**
 * Expense categories carry no campus field — they are shared configuration.
 *
 * @returns {Object[]}
 */
const buildExpenseCategories = () =>
  ['Salaries', 'Utilities', 'Supplies'].slice(0, COUNTS.GLOBAL.expenseCategories).map((name, i) => ({
    _id: oid(`expense-category:${pad(i + 1)}`),
    name,
    description: `Fixture category ${name}`,
    isDeleted: false,
    ...stamps(360),
  }));

/**
 * @param {string} campusKey
 * @param {Object} ctx
 * @returns {Object[]}
 */
const buildIncomes = (campusKey, ctx) => {
  const counts = COUNTS[campusKey];
  const students = ctx.students[campusKey];

  return Array.from({ length: counts.incomes }, (_, i) => {
    const n = pad(i + 1);
    const deleted = i + 1 > counts.incomes - counts.incomesDeleted;
    const incomeDate = ctx.at(-120 + i * 10);

    return {
      _id: oid(`income:${campusKey}:${n}`),
      title: `Income ${campusKey}${i + 1}`,
      description: 'Fixture income entry',
      reference: `INC-${campusKey}-${n}`,
      source: INCOME_SOURCES[i % INCOME_SOURCES.length],
      amount: 100000 + i * 5000,
      currency: 'XAF',
      paymentMethod: PAYMENT_METHODS[i % PAYMENT_METHODS.length],
      incomeDate,
      receivedAt: incomeDate,
      student: students[i % students.length]._id,
      class: students[i % students.length].studentClass,
      schoolCampus: ctx.campusIds[campusKey],
      receivedBy: ctx.adminIds.ADMIN,
      status: 'received',
      // `month` / `year` are derived in `pre('save')`, which `insertMany` skips;
      // the finance aggregations group on them, so an unset pair reads as zero
      // revenue rather than as a broken query.
      month: incomeDate.getUTCMonth() + 1,
      year: incomeDate.getUTCFullYear(),
      ...stamps(120 - i * 10),
      ...(deleted ? ctx.softDelete('Income', ctx.at(-12)) : { isDeleted: false }),
    };
  });
};

/**
 * @param {string} campusKey
 * @param {Object} ctx
 * @returns {Object[]}
 */
const buildExpenses = (campusKey, ctx) => {
  const counts = COUNTS[campusKey];

  return Array.from({ length: counts.expenses }, (_, i) => {
    const n = pad(i + 1);
    const deleted = i + 1 > counts.expenses - counts.expensesDeleted;
    const expenseDate = ctx.at(-100 + i * 12);

    return {
      _id: oid(`expense:${campusKey}:${n}`),
      schoolCampus: ctx.campusIds[campusKey],
      expenseCategory: oid(`expense-category:${pad((i % COUNTS.GLOBAL.expenseCategories) + 1)}`),
      paidBy: ctx.adminIds.ADMIN,
      approvedBy: ctx.adminIds.DIRECTOR,
      title: `Expense ${campusKey}${i + 1}`,
      description: 'Fixture expense entry',
      reference: `EXP-${campusKey}-${n}`,
      amount: 50000 + i * 2500,
      currency: 'XAF',
      paymentMethod: PAYMENT_METHODS[i % PAYMENT_METHODS.length],
      expenseDate,
      paidAt: expenseDate,
      status: 'paid',
      month: expenseDate.getUTCMonth() + 1,
      year: expenseDate.getUTCFullYear(),
      ...stamps(100 - i * 12),
      ...(deleted ? ctx.softDelete('Expense', ctx.at(-11)) : { isDeleted: false }),
    };
  });
};

/**
 * Student debts. The first `studentFeesOverdue` of each campus are past due with a
 * balance left — that is what the nightly reminder cron looks for.
 *
 * @param {string} campusKey
 * @param {Object} ctx
 * @returns {{ fees: Object[], payments: Object[] }}
 */
const buildStudentFees = (campusKey, ctx) => {
  const counts = COUNTS[campusKey];
  const students = ctx.students[campusKey];
  const fees = [];
  const payments = [];

  for (let i = 0; i < counts.studentFees; i += 1) {
    const n = pad(i + 1);
    const student = students[i % students.length];
    const deleted = i + 1 > counts.studentFees - counts.studentFeesDeleted;
    const overdue = i < counts.studentFeesOverdue;
    const paidInFull = !overdue && i % 3 === 0;
    const partiallyPaid = !overdue && i % 3 === 1;

    const amountDue = 150000;
    let amountPaid = 0;
    if (paidInFull) amountPaid = amountDue;
    if (partiallyPaid) amountPaid = 50000;
    if (overdue) amountPaid = i === 0 ? 0 : 25000;

    const fee = {
      _id: oid(`student-fee:${campusKey}:${n}`),
      student: student._id,
      schoolCampus: ctx.campusIds[campusKey],
      label: `Tuition instalment ${i + 1}`,
      academicYear: ACADEMIC_YEAR,
      amountDue,
      amountPaid,
      currency: 'XAF',
      dueDate: overdue ? ctx.at(-45 - i) : ctx.at(30 + i),
      createdBy: ctx.adminIds.ADMIN,
      ...stamps(150 - i * 5),
      ...(deleted ? ctx.softDelete('StudentFee', ctx.at(-9)) : { isDeleted: false }),
    };

    // The status is derived by the application's own rule, evaluated at the
    // anchor rather than at the wall clock.
    fee.status = computeStatus(fee, ANCHOR_DATE);
    fees.push(fee);

    if (amountPaid > 0 && payments.length < counts.feePayments) {
      payments.push({
        _id: oid(`fee-payment:${campusKey}:${pad(payments.length + 1)}`),
        fee: fee._id,
        student: student._id,
        schoolCampus: ctx.campusIds[campusKey],
        amount: amountPaid,
        currency: 'XAF',
        method: PAYMENT_METHODS[i % PAYMENT_METHODS.length],
        reference: `PAY-${campusKey}-${pad(payments.length + 1)}`,
        paidAt: ctx.at(-60 + i),
        recordedBy: ctx.adminIds.ADMIN,
        notes: 'Fixture payment',
        ...stamps(60 - i),
      });
    }
  }

  return { fees, payments };
};

/**
 * @param {Object} ctx
 * @returns {Array<{ model: string, docs: Object[] }>}
 */
const build = (ctx) => {
  const feeSets = CAMPUS_KEYS.map((key) => buildStudentFees(key, ctx));

  return [
    { model: 'ExpenseCategory', docs: buildExpenseCategories() },
    { model: 'Income', docs: CAMPUS_KEYS.flatMap((key) => buildIncomes(key, ctx)) },
    { model: 'Expense', docs: CAMPUS_KEYS.flatMap((key) => buildExpenses(key, ctx)) },
    { model: 'StudentFee', docs: feeSets.flatMap((s) => s.fees) },
    { model: 'FeePayment', docs: feeSets.flatMap((s) => s.payments) },
  ];
};

module.exports = { build };
