'use strict';

/**
 * @file email.channel.js — email channel (SMTP via nodemailer).
 *
 * INERT by default: if the SMTP config is absent OR if `nodemailer` is not
 * installed, `isConfigured()` returns false and the service marks the send `skipped`
 * (never an error). No network call is attempted in dev / CI / tests.
 *
 * The transporter is created lazily and cached.
 */

const config = require('../../../shared/configs/general.config');

// nodemailer is optional: we load it lazily so as not to break the app if the
// dependency is not installed (the channel is simply inactive).
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
 * @throws on SMTP failure (the service decides on the retry).
 */
const send = async ({ to, subject, body }) => {
  if (!to) throw new Error('Email channel: missing recipient address');
  const from = config.email.fromName
    ? `${config.email.fromName} <${config.email.from}>`
    : config.email.from;
  await getTransporter().sendMail({ from, to, subject: subject || '', text: body });
  return { ok: true };
};

// Resets the transporter cache (useful for tests).
const _reset = () => { transporter = null; };

module.exports = { name: 'email', isConfigured, send, _reset };
