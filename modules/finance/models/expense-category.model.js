'use strict';

const mongoose = require('mongoose');

/**
 * ExpenseCategory — a lookup category for institutional expenses
 * (salaries, rent, supplies, maintenance…). Referenced by Expense.
 */
const expenseCategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'name is required'],
      trim: true,
      maxlength: [100, 'name must not exceed 100 characters'],
    },

    description: {
      type: String,
      trim: true,
      maxlength: [300, 'description must not exceed 300 characters'],
    },

    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('ExpenseCategory', expenseCategorySchema);
