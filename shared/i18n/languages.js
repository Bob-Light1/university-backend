'use strict';

/**
 * @file shared/i18n/languages.js — source unique des langues supportées.
 *
 * Avant ce fichier, la liste était dupliquée dans
 * `shared/middleware/locale.middleware.js` et
 * `modules/settings/models/userPreferences.model.js`. Elle vit désormais ici ;
 * ces deux modules l'importent. Pour ajouter une langue : étendre SUPPORTED_LANGUAGES
 * et fournir ses traductions dans `shared/i18n/catalogs/*`.
 */

// Ordre = priorité d'affichage (en d'abord, c'est aussi le repli).
const SUPPORTED_LANGUAGES = ['en', 'fr', 'es', 'ar', 'zh-CN', 'de', 'pt', 'it', 'ru', 'ja'];

const DEFAULT_LOCALE = 'en';

// Langues à script droite-à-gauche — utile pour le rendu (email/UI).
const RTL_LANGUAGES = ['ar'];

const isSupported = (code) => SUPPORTED_LANGUAGES.includes(code);

/**
 * Ramène un code arbitraire vers une langue supportée, sinon null.
 * Gère « fr-FR » → « fr » et toute variante « zh-* » → « zh-CN ».
 */
function normalize(code) {
  if (!code || typeof code !== 'string') return null;
  const tag = code.trim();
  if (isSupported(tag)) return tag;
  const base = tag.split('-')[0].toLowerCase();
  if (isSupported(base)) return base;
  if (base === 'zh') return 'zh-CN';
  return null;
}

module.exports = { SUPPORTED_LANGUAGES, DEFAULT_LOCALE, RTL_LANGUAGES, isSupported, normalize };
