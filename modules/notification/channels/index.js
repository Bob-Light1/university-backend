'use strict';

/**
 * @file channels/index.js — registre des canaux de notification.
 *
 * Chaque canal expose : { name, isConfigured(), send(message) }.
 * Le service interroge `isConfigured()` avant d'envoyer ; un canal non configuré
 * produit un statut `skipped`, jamais une erreur.
 */

const inapp    = require('./inapp.channel');
const email    = require('./email.channel');
const whatsapp = require('./whatsapp.channel');

const registry = { inapp, email, whatsapp };

const get = (name) => registry[name] || null;

module.exports = { registry, get };
