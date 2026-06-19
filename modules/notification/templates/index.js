'use strict';

/**
 * @file templates/index.js — notification template renderer.
 *
 * The CONTENT now lives in the central i18n catalog
 * (`shared/i18n/catalogs/notifications.js`); this file only resolves it
 * by channel/locale and interpolates it. The primitives (`pick`,
 * `interpolate`) and the list of languages come from `shared/i18n`.
 *
 * The `generic` template is short-circuited: it passes through content already
 * written by the caller (`data.subject` / `data.body`) — useful for ad hoc
 * broadcasts, hence absent from the catalog.
 */

const { pick, interpolate, DEFAULT_LOCALE } = require('../../../shared/i18n');
const catalog = require('../../../shared/i18n/catalogs/notifications');

const GENERIC = 'generic';

/**
 * Renders the content of a template for a given channel.
 * @returns {{subject: string|null, body: string}}
 * @throws if the template or the channel is unknown.
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
