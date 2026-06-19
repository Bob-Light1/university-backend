'use strict';

/**
 * @file shared/i18n/languages.js — single source of supported languages.
 *
 * Before this file, the list was duplicated in
 * `shared/middleware/locale.middleware.js` and
 * `modules/settings/models/userPreferences.model.js`. It now lives here;
 * both modules import it. To add a language: extend SUPPORTED_LANGUAGES
 * and provide its translations in `shared/i18n/catalogs/*`.
 */

// Order = display priority (en first, which is also the fallback).
const SUPPORTED_LANGUAGES = ['en', 'fr', 'es', 'ar', 'zh-CN', 'de', 'pt', 'it', 'ru', 'ja'];

const DEFAULT_LOCALE = 'en';

// Right-to-left script languages — useful for rendering (email/UI).
const RTL_LANGUAGES = ['ar'];

const isSupported = (code) => SUPPORTED_LANGUAGES.includes(code);

/**
 * Maps an arbitrary code to a supported language, or null otherwise.
 * Handles « fr-FR » → « fr » and any « zh-* » variant → « zh-CN ».
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
