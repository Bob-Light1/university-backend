'use strict';
/** @file whatsapp.templates.js @description Strict approved-pair selection and exact Meta submission catalogue. */
const catalog = require('../../shared/i18n/catalogs/notifications');
const { TEMPLATE_PARAMETERS, META_LANGUAGES } = require('../../shared/constants/whatsapp.constants');
const config = require('../../shared/configs/general.config');
/** Select a configured approved template; malformed configuration fails closed. */
function resolve(template, locale, data = {}) {
  const parameters = TEMPLATE_PARAMETERS[template];
  if (!parameters || !META_LANGUAGES[locale]) return null;
  let approved;
  try { approved = JSON.parse(config.notification.whatsapp.approvedTemplates); } catch { return null; }
  const entry = approved?.[template]?.[locale];
  if (!entry || entry.approved !== true || typeof entry.name !== 'string'
    || !/^[a-z0-9_]{1,512}$/.test(entry.name) || entry.language !== META_LANGUAGES[locale]) return null;
  if (parameters.some(key => data[key] == null || !String(data[key]).trim() || String(data[key]).length > 1024)) return null;
  const components = parameters.length ? [{ type: 'body', parameters: parameters.map(key => ({ type: 'text', text: String(data[key]) })) }] : [];
  return { name: entry.name, language: { code: entry.language }, components };
}
/** Export all ten exact translated bodies with positional variables for Meta approval. */
function submissionCatalog() {
  return Object.entries(TEMPLATE_PARAMETERS).flatMap(([key, parameters]) => Object.entries(META_LANGUAGES).map(([locale, language]) => {
    let body = catalog[key].whatsapp.body[locale];
    for (const [index, parameter] of parameters.entries()) body = body.replaceAll(`{${parameter}}`, `{{${index + 1}}}`);
    return { key, locale, language, suggestedName: `erp_${key.replaceAll('.', '_')}`, category: 'UTILITY', parameters, body };
  }));
}
module.exports = { resolve, submissionCatalog };
