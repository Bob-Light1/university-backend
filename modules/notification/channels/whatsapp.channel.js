'use strict';

/**
 * @file whatsapp.channel.js — WhatsApp channel (Meta Cloud API).
 *
 * Native HTTPS call (`fetch`, Node 18+) — no SDK. INERT by default: without a
 * token or phoneNumberId, `isConfigured()` returns false and the service marks
 * the send `skipped`. No network call in dev / CI / tests.
 *
 * Sends a free-form text message (outside the 24h window, Meta requires an
 * approved template; here we cover the text-message case, enough for the foundation).
 */

const config = require('../../../shared/configs/general.config');

const wa = () => config.notification.whatsapp;

const isConfigured = () => Boolean(wa().token && wa().phoneNumberId);

// Normalizes a number to digits only (Meta expects E.164 without the « + »).
const normalize = (phone) => String(phone || '').replace(/[^\d]/g, '');

/**
 * @param {{to: string, body: string}} message
 * @returns {Promise<{ok: boolean}>}
 * @throws if the Meta API returns an error (the service decides on the retry).
 */
const send = async ({ to, body }) => {
  const phone = normalize(to);
  if (!phone) throw new Error('WhatsApp channel: missing recipient phone');

  const { token, phoneNumberId, apiVersion } = wa();
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: phone,
      type: 'text',
      text: { body },
    }),
  });

  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch { detail = res.statusText; }
    throw new Error(`WhatsApp API ${res.status}: ${detail}`);
  }
  return { ok: true };
};

module.exports = { name: 'whatsapp', isConfigured, send };
