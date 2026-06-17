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

  'result.published': {
    inapp: (d, l) => ({
      subject: pick({ en: 'New result available', fr: 'Nouveau résultat disponible' }, l),
      body: interpolate(pick({
        en: 'A new result has been published. You can now view it in your results.',
        fr: 'Un nouveau résultat a été publié. Vous pouvez le consulter dans vos résultats.',
      }, l), d),
    }),
    email: (d, l) => ({
      subject: pick({ en: 'Your result has been published', fr: 'Votre résultat a été publié' }, l),
      body: interpolate(pick({
        en: 'Hello {name},\n\nA new result has been published and is now available in your portal.',
        fr: 'Bonjour {name},\n\nUn nouveau résultat a été publié et est disponible sur votre portail.',
      }, l), d),
    }),
    whatsapp: (d, l) => ({
      body: interpolate(pick({
        en: 'A new result has been published. Check your portal.',
        fr: 'Un nouveau résultat a été publié. Consultez votre portail.',
      }, l), d),
    }),
  },

  'exam.graded': {
    inapp: (d, l) => ({
      subject: pick({ en: 'Exam grade published', fr: 'Note d\'examen publiée' }, l),
      body: interpolate(pick({
        en: 'Your grade for an exam has been published. You can now view it.',
        fr: 'Votre note d\'examen a été publiée. Vous pouvez la consulter.',
      }, l), d),
    }),
    email: (d, l) => ({
      subject: pick({ en: 'Your exam grade is available', fr: 'Votre note d\'examen est disponible' }, l),
      body: interpolate(pick({
        en: 'Hello {name},\n\nYour grade for an exam has been published and is now available in your portal.',
        fr: 'Bonjour {name},\n\nVotre note d\'examen a été publiée et est disponible sur votre portail.',
      }, l), d),
    }),
    whatsapp: (d, l) => ({
      body: interpolate(pick({
        en: 'Your exam grade has been published. Check your portal.',
        fr: 'Votre note d\'examen a été publiée. Consultez votre portail.',
      }, l), d),
    }),
  },

  'fraud.alert': {
    inapp: (d, l) => ({
      subject: pick({ en: 'Suspicious activity detected', fr: 'Activité suspecte détectée' }, l),
      body: interpolate(pick({
        en: 'A burst of {count} pre-registrations from the same source was flagged. Please review the recent leads.',
        fr: 'Une rafale de {count} pré-inscriptions depuis la même source a été signalée. Vérifiez les leads récents.',
      }, l), d),
    }),
    email: (d, l) => ({
      subject: pick({ en: 'Anti-fraud alert: suspicious pre-registrations', fr: 'Alerte anti-fraude : pré-inscriptions suspectes' }, l),
      body: interpolate(pick({
        en: 'A burst of {count} pre-registrations from the same source was flagged on your campus. Please review the recent leads in your dashboard.',
        fr: 'Une rafale de {count} pré-inscriptions depuis la même source a été signalée sur votre campus. Vérifiez les leads récents dans votre tableau de bord.',
      }, l), d),
    }),
    whatsapp: (d, l) => ({
      body: interpolate(pick({
        en: 'Anti-fraud alert: {count} suspicious pre-registrations flagged. Check your dashboard.',
        fr: 'Alerte anti-fraude : {count} pré-inscriptions suspectes signalées. Consultez votre tableau de bord.',
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
