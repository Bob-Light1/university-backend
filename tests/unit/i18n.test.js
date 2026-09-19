'use strict';

/**
 * Socle i18n (Phase 2 — catalogue central).
 * Vérifie la source unique des langues, les primitives (pick/normalize/interpolate)
 * et — surtout — que CHAQUE feuille du catalogue notifications couvre les 10 langues.
 * C'est le garde-fou contre une traduction oubliée lors de l'ajout d'un template.
 */

const i18n = require('../../shared/i18n');
const catalog = require('../../shared/i18n/catalogs/notifications');

describe('source unique des langues', () => {
  test('expose exactement les 10 langues supportées, en en premier (repli)', () => {
    expect(i18n.SUPPORTED_LANGUAGES).toEqual(['en', 'fr', 'es', 'ar', 'zh-CN', 'de', 'pt', 'it', 'ru', 'ja']);
    expect(i18n.DEFAULT_LOCALE).toBe('en');
    expect(i18n.SUPPORTED_LANGUAGES[0]).toBe(i18n.DEFAULT_LOCALE);
  });
});

describe('normalize', () => {
  test('ramène les variantes vers une langue supportée', () => {
    expect(i18n.normalize('fr-FR')).toBe('fr');
    expect(i18n.normalize('zh-TW')).toBe('zh-CN');
    expect(i18n.normalize('pt')).toBe('pt');
    expect(i18n.normalize('xx')).toBeNull();
    expect(i18n.normalize(null)).toBeNull();
  });
});

describe('pick / interpolate', () => {
  test('pick choisit la locale puis replie sur en', () => {
    const dict = { en: 'Hello', fr: 'Bonjour' };
    expect(i18n.pick(dict, 'fr')).toBe('Bonjour');
    expect(i18n.pick(dict, 'xx')).toBe('Hello'); // repli en
    expect(i18n.pick('brut', 'fr')).toBe('brut'); // raw string passthrough
  });

  test('interpolate remplace les variables et vide les manquantes', () => {
    expect(i18n.interpolate('Hi {name}', { name: 'Alice' })).toBe('Hi Alice');
    expect(i18n.interpolate('Hi {name}', {})).toBe('Hi ');
  });
});

describe('localeContext', () => {
  // Extracted from academic-pdf.service.js when the fee receipt became the
  // second server-rendered document (design note §9④): two documents issued by
  // the same campus must not write a date two different ways.
  test('résout les quatre attributs d\'un document rendu', () => {
    expect(i18n.localeContext('fr')).toEqual({
      lang: 'fr', htmlLang: 'fr', dateLocale: 'fr-FR', dir: 'ltr',
    });
  });

  test('l\'arabe est la seule langue rtl du socle', () => {
    expect(i18n.localeContext('ar').dir).toBe('rtl');
    for (const lang of i18n.SUPPORTED_LANGUAGES.filter((l) => l !== 'ar')) {
      expect(i18n.localeContext(lang).dir).toBe('ltr');
    }
  });

  test('une locale inconnue, absente ou régionale retombe sur une langue supportée', () => {
    expect(i18n.localeContext('fr-CA').lang).toBe('fr');
    expect(i18n.localeContext('xx').lang).toBe(i18n.DEFAULT_LOCALE);
    expect(i18n.localeContext(undefined).lang).toBe(i18n.DEFAULT_LOCALE);
    expect(i18n.localeContext(null).lang).toBe(i18n.DEFAULT_LOCALE);
  });

  test('chaque langue supportée a une table de dates et un attribut lang', () => {
    for (const lang of i18n.SUPPORTED_LANGUAGES) {
      const ctx = i18n.localeContext(lang);
      expect(typeof ctx.dateLocale).toBe('string');
      expect(ctx.dateLocale.length).toBeGreaterThan(0);
      expect(typeof ctx.htmlLang).toBe('string');
      expect(ctx.htmlLang.length).toBeGreaterThan(0);
    }
  });
});

describe('couverture du catalogue notifications', () => {
  // Collects all leaves (dicts { lang: text }) of the catalog.
  const leaves = [];
  for (const [template, channels] of Object.entries(catalog)) {
    for (const [channel, parts] of Object.entries(channels)) {
      for (const [part, dict] of Object.entries(parts)) {
        leaves.push({ id: `${template}.${channel}.${part}`, dict });
      }
    }
  }

  test('le catalogue contient des entrées', () => {
    expect(leaves.length).toBeGreaterThan(0);
  });

  test.each(leaves.map((l) => [l.id, l.dict]))(
    '%s couvre les 10 langues sans texte vide',
    (_id, dict) => {
      for (const lang of i18n.SUPPORTED_LANGUAGES) {
        expect(typeof dict[lang]).toBe('string');
        expect(dict[lang].trim().length).toBeGreaterThan(0);
      }
    }
  );
});
