'use strict';

/**
 * @file email.channel.js — canal email (SMTP via nodemailer).
 *
 * INERTE par défaut : si la config SMTP est absente OU si `nodemailer` n'est pas
 * installé, `isConfigured()` renvoie false et le service marque l'envoi `skipped`
 * (jamais d'erreur). Aucun appel réseau n'est tenté en dev / CI / tests.
 *
 * Le transporteur est créé paresseusement et mis en cache.
 */

const config = require('../../../shared/configs/general.config');

// nodemailer est optionnel : on le charge paresseusement pour ne pas casser
// l'app si la dépendance n'est pas installée (canal simplement inactif).
let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch {
  nodemailer = null;
}

let transporter = null;

const smtp = () => config.notification.smtp;

const isConfigured = () =>
  Boolean(nodemailer && smtp().host && smtp().user && smtp().password);

function getTransporter() {
  if (transporter) return transporter;
  const { host, port, secure, user, password } = smtp();
  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass: password },
  });
  return transporter;
}

/**
 * @param {{to: string, subject: string, body: string}} message
 * @returns {Promise<{ok: boolean}>}
 * @throws en cas d'échec SMTP (le service décide du retry).
 */
const send = async ({ to, subject, body }) => {
  if (!to) throw new Error('Email channel: missing recipient address');
  const from = config.email.fromName
    ? `${config.email.fromName} <${config.email.from}>`
    : config.email.from;
  await getTransporter().sendMail({ from, to, subject: subject || '', text: body });
  return { ok: true };
};

// Réinitialise le cache du transporteur (utile aux tests).
const _reset = () => { transporter = null; };

module.exports = { name: 'email', isConfigured, send, _reset };
