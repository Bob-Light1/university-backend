'use strict';

/**
 * @file channels/index.js — notification channel registry.
 *
 * Each channel exposes: { name, isConfigured(), send(message) }.
 * The service queries `isConfigured()` before sending; an unconfigured channel
 * produces a `skipped` status, never an error.
 */

const inapp    = require('./inapp.channel');
const email    = require('./email.channel');
const whatsapp = require('./whatsapp.channel');

const registry = { inapp, email, whatsapp };

const get = (name) => registry[name] || null;

module.exports = { registry, get };
