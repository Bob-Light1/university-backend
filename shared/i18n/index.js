'use strict';

/**
 * @file shared/i18n/index.js — shared i18n primitives + public API.
 *
 * Single entry point: require('../../shared/i18n').
 * Provides locale fallback (`pick`), variable interpolation
 * (`interpolate`), and a catalog resolver (`t`). Message catalogs
 * live in `./catalogs/*`; each domain drops its own there.
 */

const { SUPPORTED_LANGUAGES, DEFAULT_LOCALE, RTL_LANGUAGES, isSupported, normalize } = require('./languages');

/**
 * Picks the localized string from a dictionary { en, fr, ... }.
 * Cascading fallback: requested locale → English → first available value → ''.
 * @param {Object|string} dict  translation dictionary, or raw string
 * @param {string} locale
 * @returns {string}
 */
function pick(dict, locale = DEFAULT_LOCALE) {
  if (dict && typeof dict === 'object') {
    return dict[locale] ?? dict[DEFAULT_LOCALE] ?? Object.values(dict)[0] ?? '';
  }
  return dict ?? '';
}

// Minimal interpolation: « Bonjour {name} » + { name: 'Alice' } → « Bonjour Alice ».
function interpolate(str, data = {}) {
  return String(str).replace(/\{(\w+)\}/g, (_, key) =>
    data[key] !== undefined && data[key] !== null ? String(data[key]) : ''
  );
}

/**
 * Resolves a catalog entry by dotted path, localizes and interpolates.
 * @param {Object} catalog  tree of dictionaries { en, fr, ... } at the leaves
 * @param {string} path     e.g. 'account.welcome.email.subject'
 * @param {string} locale
 * @param {Object} [data]   interpolation variables
 * @returns {string}
 */
function t(catalog, path, locale = DEFAULT_LOCALE, data = {}) {
  const dict = path.split('.').reduce((node, key) => (node == null ? node : node[key]), catalog);
  return interpolate(pick(dict, locale), data);
}

module.exports = {
  SUPPORTED_LANGUAGES,
  DEFAULT_LOCALE,
  RTL_LANGUAGES,
  isSupported,
  normalize,
  pick,
  interpolate,
  t,
};
