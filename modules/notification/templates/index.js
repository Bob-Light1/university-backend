'use strict';

/**
 * @file templates/index.js — renderer des templates de notification.
 *
 * Le CONTENU vit désormais dans le catalogue i18n central
 * (`shared/i18n/catalogs/notifications.js`) ; ce fichier ne fait plus que le
 * résoudre par canal/locale et l'interpoler. Les primitives (`pick`,
 * `interpolate`) et la liste des langues viennent de `shared/i18n`.
 *
 * Le template `generic` est court-circuité : il laisse passer un contenu déjà
 * rédigé par l'appelant (`data.subject` / `data.body`) — utile pour les
 * diffusions ad hoc, donc absent du catalogue.
 */

const { pick, interpolate, DEFAULT_LOCALE } = require('../../../shared/i18n');
const catalog = require('../../../shared/i18n/catalogs/notifications');

const GENERIC = 'generic';

/**
 * Rend le contenu d'un template pour un canal donné.
 * @returns {{subject: string|null, body: string}}
 * @throws si le template ou le canal est inconnu.
 */
function render(template, channel, data = {}, locale = DEFAULT_LOCALE) {
  if (template === GENERIC) {
    const subject = channel === 'whatsapp' ? null : (data.subject ?? null);
    return { subject, body: data.body ?? '' };
  }

  const entry = catalog[template];
  if (!entry) throw new Error(`Unknown notification template: '${template}'`);
  const channelDef = entry[channel];
  if (!channelDef) throw new Error(`Template '${template}' does not support channel '${channel}'`);

  const subject = channelDef.subject ? interpolate(pick(channelDef.subject, locale), data) : null;
  const body = interpolate(pick(channelDef.body, locale), data);
  return { subject, body };
}

const has = (template) =>
  template === GENERIC || Object.prototype.hasOwnProperty.call(catalog, template);

const TEMPLATE_KEYS = [GENERIC, ...Object.keys(catalog)];

module.exports = { render, has, interpolate, DEFAULT_LOCALE, TEMPLATE_KEYS };
