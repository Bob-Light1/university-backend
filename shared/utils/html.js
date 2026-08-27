'use strict';

/**
 * @file shared/utils/html.js — HTML escaping for server-rendered markup.
 *
 * Extracted because three PDF renderers now build HTML strings by hand — the
 * GED (`document.pdf.service.js`), the academic prints (`academic-pdf.service.js`)
 * and the fee receipt (`fee-receipt.template.js`). Each carried its own copy of
 * the same five replacements, and a rule that decides whether a student's name
 * can close a tag is not a rule that should exist in three versions: a fix
 * applied to one copy leaves the other two exploitable.
 */

/**
 * Escapes the five characters that let a value break out of an HTML attribute
 * or text node. `null` / `undefined` render as an empty string rather than as
 * the literal words, which is what every call site wants for a missing field.
 *
 * @param {*} value
 * @returns {string}
 */
const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

module.exports = { escapeHtml };
