'use strict';

/**
 * @file shared/i18n/index.js — primitives i18n partagées + API publique.
 *
 * Point d'entrée unique : require('../../shared/i18n').
 * Fournit le repli de locale (`pick`), l'interpolation de variables
 * (`interpolate`), et un résolveur de catalogue (`t`). Les catalogues de
 * messages vivent dans `./catalogs/*` ; chaque domaine y dépose le sien.
 */

const { SUPPORTED_LANGUAGES, DEFAULT_LOCALE, RTL_LANGUAGES, isSupported, normalize } = require('./languages');

/**
 * Choisit la chaîne localisée d'un dictionnaire { en, fr, ... }.
 * Repli en cascade : locale demandée → anglais → première valeur dispo → ''.
 * @param {Object|string} dict  dictionnaire de traductions, ou chaîne brute
 * @param {string} locale
 * @returns {string}
 */
function pick(dict, locale = DEFAULT_LOCALE) {
  if (dict && typeof dict === 'object') {
    return dict[locale] ?? dict[DEFAULT_LOCALE] ?? Object.values(dict)[0] ?? '';
  }
  return dict ?? '';
}

// Interpolation minimale : « Bonjour {name} » + { name: 'Alice' } → « Bonjour Alice ».
function interpolate(str, data = {}) {
  return String(str).replace(/\{(\w+)\}/g, (_, key) =>
    data[key] !== undefined && data[key] !== null ? String(data[key]) : ''
  );
}

/**
 * Résout une entrée de catalogue par chemin pointé, localise et interpole.
 * @param {Object} catalog  arbre de dictionnaires { en, fr, ... } en feuilles
 * @param {string} path     ex. 'account.welcome.email.subject'
 * @param {string} locale
 * @param {Object} [data]   variables d'interpolation
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
