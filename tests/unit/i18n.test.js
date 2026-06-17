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
    expect(i18n.pick('brut', 'fr')).toBe('brut'); // chaîne brute passe-plat
  });

  test('interpolate remplace les variables et vide les manquantes', () => {
    expect(i18n.interpolate('Hi {name}', { name: 'Alice' })).toBe('Hi Alice');
    expect(i18n.interpolate('Hi {name}', {})).toBe('Hi ');
  });
});

describe('couverture du catalogue notifications', () => {
  // Collecte toutes les feuilles (dicts { lang: texte }) du catalogue.
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
