'use strict';

/** @file announcement.validation.js @description Shared optional future-date validation for creation and mutation. */

/** Return the existing validation message, or null for an omitted/cleared/future date. */
function futureDateError(value, label, now = new Date()) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return `Invalid ${label}.`;
  if (date <= now) return `${label} must be in the future.`;
  return null;
}

module.exports = { futureDateError };
