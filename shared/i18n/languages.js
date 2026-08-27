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

/**
 * BCP-47 tags accepted by `Intl` / `Date#toLocaleDateString`, per supported
 * language. Our codes are not all valid tags on their own: `en` formats dates
 * US-style and `pt` European-style, neither of which is what the platform means.
 *
 * Lived in `academic-pdf.service.js` until the fee receipt became the second
 * renderer needing it. A date or an amount formatted from a different table than
 * its neighbouring document is a discrepancy nobody reads as a bug.
 */
const DATE_LOCALES = Object.freeze({
  en: 'en-GB', fr: 'fr-FR', es: 'es-ES', ar: 'ar-SA', 'zh-CN': 'zh-CN',
  de: 'de-DE', pt: 'pt-BR', it: 'it-IT', ru: 'ru-RU', ja: 'ja-JP',
});

/** Value of the HTML `lang` attribute, per supported language. */
const HTML_LANGS = Object.freeze({
  en: 'en', fr: 'fr', es: 'es', ar: 'ar', 'zh-CN': 'zh',
  de: 'de', pt: 'pt', it: 'it', ru: 'ru', ja: 'ja',
});

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

/**
 * Everything a renderer needs to lay out a document in one language: the
 * normalized code, its HTML `lang`, its formatting tag and its direction.
 * Unsupported or missing input resolves to the default locale rather than
 * throwing — a PDF renders in English, it never fails to render.
 *
 * @param {string} [locale]
 * @returns {{ lang: string, htmlLang: string, dateLocale: string, dir: 'ltr'|'rtl' }}
 */
function localeContext(locale = DEFAULT_LOCALE) {
  const lang = normalize(locale) || DEFAULT_LOCALE;
  return {
    lang,
    htmlLang:   HTML_LANGS[lang]   || HTML_LANGS[DEFAULT_LOCALE],
    dateLocale: DATE_LOCALES[lang] || DATE_LOCALES[DEFAULT_LOCALE],
    dir:        RTL_LANGUAGES.includes(lang) ? 'rtl' : 'ltr',
  };
}

module.exports = {
  SUPPORTED_LANGUAGES,
  DEFAULT_LOCALE,
  RTL_LANGUAGES,
  DATE_LOCALES,
  HTML_LANGS,
  isSupported,
  normalize,
  localeContext,
};
