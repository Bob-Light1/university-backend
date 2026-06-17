'use strict';

/**
 * @file templates/index.js — registre des templates de notification.
 *
 * Un template fournit, par canal, le contenu rendu à partir des variables `data`
 * et de la `locale`. Conçu i18n-ready : chaque libellé est un dictionnaire
 * { en, fr, ... } résolu par `pick(locale)`, avec repli sur l'anglais. Le jour où
 * le catalogue i18n global existera, ces dictionnaires viendront de lui.
 *
 * Le template `generic` laisse passer un contenu déjà rédigé par l'appelant
 * (`data.subject` / `data.body`) — utile pour les diffusions ad hoc.
 */

const DEFAULT_LOCALE = 'en';

// Interpolation minimale : « Bonjour {name} » + data.name → « Bonjour Alice ».
function interpolate(str, data = {}) {
  return String(str).replace(/\{(\w+)\}/g, (_, key) =>
    data[key] !== undefined && data[key] !== null ? String(data[key]) : ''
  );
}

// Choisit la chaîne localisée d'un dictionnaire { en, fr, ... } avec repli en.
function pick(dict, locale) {
  if (dict && typeof dict === 'object') return dict[locale] ?? dict[DEFAULT_LOCALE] ?? '';
  return dict ?? '';
}

/**
 * Chaque entrée renvoie le contenu d'un canal :
 *   - inapp/email → { subject, body }
 *   - whatsapp    → { body }
 * Tous reçoivent (data, locale).
 */
const templates = {
  generic: {
    inapp:    (d) => ({ subject: d.subject ?? null, body: d.body ?? '' }),
    email:    (d) => ({ subject: d.subject ?? null, body: d.body ?? '' }),
    whatsapp: (d) => ({ body: d.body ?? '' }),
  },

  'account.welcome': {
    inapp: (d, l) => ({
      subject: pick({ en: 'Welcome', fr: 'Bienvenue' }, l),
      body: interpolate(pick({
        en: 'Welcome {name}, your account is ready.',
        fr: 'Bienvenue {name}, votre compte est prêt.',
      }, l), d),
    }),
    email: (d, l) => ({
      subject: pick({ en: 'Welcome to your campus portal', fr: 'Bienvenue sur votre portail' }, l),
      body: interpolate(pick({
        en: 'Hello {name},\n\nYour account is ready. You can now sign in.',
        fr: 'Bonjour {name},\n\nVotre compte est prêt. Vous pouvez vous connecter.',
      }, l), d),
    }),
    whatsapp: (d, l) => ({
      body: interpolate(pick({
        en: 'Welcome {name}! Your account is ready.',
        fr: 'Bienvenue {name} ! Votre compte est prêt.',
      }, l), d),
    }),
  },

  'payment.reminder': {
    inapp: (d, l) => ({
      subject: pick({ en: 'Payment due', fr: 'Paiement à venir' }, l),
      body: interpolate(pick({
        en: 'You have a balance of {amount} {currency} due on {dueDate}.',
        fr: 'Vous avez un solde de {amount} {currency} à régler avant le {dueDate}.',
      }, l), d),
    }),
    email: (d, l) => ({
      subject: pick({ en: 'Payment reminder', fr: 'Rappel de paiement' }, l),
      body: interpolate(pick({
        en: 'Hello {name},\n\nA balance of {amount} {currency} is due on {dueDate}.',
        fr: 'Bonjour {name},\n\nUn solde de {amount} {currency} est à régler avant le {dueDate}.',
      }, l), d),
    }),
    whatsapp: (d, l) => ({
      body: interpolate(pick({
        en: 'Reminder: {amount} {currency} due on {dueDate}.',
        fr: 'Rappel : {amount} {currency} à régler avant le {dueDate}.',
      }, l), d),
    }),
  },
};

/**
 * Rend le contenu d'un template pour un canal donné.
 * @returns {{subject?: string|null, body: string}}
 * @throws si le template ou le canal est inconnu.
 */
function render(template, channel, data = {}, locale = DEFAULT_LOCALE) {
  const entry = templates[template];
  if (!entry) throw new Error(`Unknown notification template: '${template}'`);
  const fn = entry[channel];
  if (!fn) throw new Error(`Template '${template}' does not support channel '${channel}'`);
  const out = fn(data, locale) || {};
  return { subject: out.subject ?? null, body: out.body ?? '' };
}

const has = (template) => Object.prototype.hasOwnProperty.call(templates, template);

module.exports = { render, has, interpolate, DEFAULT_LOCALE, TEMPLATE_KEYS: Object.keys(templates) };
