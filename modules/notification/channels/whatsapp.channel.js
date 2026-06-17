'use strict';

/**
 * @file whatsapp.channel.js — canal WhatsApp (Meta Cloud API).
 *
 * Appel HTTPS natif (`fetch`, Node 18+) — aucun SDK. INERTE par défaut : sans
 * token ni phoneNumberId, `isConfigured()` renvoie false et le service marque
 * l'envoi `skipped`. Aucun appel réseau en dev / CI / tests.
 *
 * Envoie un message texte libre (hors fenêtre 24 h, Meta exige un template
 * approuvé ; on couvre ici le cas message-texte, suffisant pour le socle).
 */

const config = require('../../../shared/configs/general.config');

const wa = () => config.notification.whatsapp;

const isConfigured = () => Boolean(wa().token && wa().phoneNumberId);

// Normalise un numéro en chiffres seulement (Meta attend l'E.164 sans « + »).
const normalize = (phone) => String(phone || '').replace(/[^\d]/g, '');

/**
 * @param {{to: string, body: string}} message
 * @returns {Promise<{ok: boolean}>}
 * @throws si l'API Meta renvoie une erreur (le service décide du retry).
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
