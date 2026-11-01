'use strict';
/** @file whatsapp.channel.js @description Bounded native HTTPS template submissions; no free-text fallback. */
const config = require('../../../shared/configs/general.config');
const { normalizePhone } = require('../../../shared/constants/whatsapp.constants');
const wa = () => config.notification.whatsapp;
/** Deployment must explicitly supply provider credentials and a Graph API version. */
const isConfigured = () => Boolean(wa().token && /^\d+$/.test(wa().phoneNumberId || '') && /^v\d+\.\d+$/.test(wa().apiVersion));
/** Send exactly one approved payload; never expose provider response bodies or secrets. */
async function send({ to, template, notificationId }) {
  const phone = normalizePhone(to);
  if (!phone || !template || !isConfigured()) throw new Error('WhatsApp submission is not configured');
  const { token, phoneNumberId, apiVersion, timeoutMs } = wa();
  const response = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: phone.slice(1), type: 'template', template, biz_opaque_callback_data: String(notificationId) }),
  });
  if (!response.ok) throw new Error(`WhatsApp submission refused (HTTP ${response.status})`);
  const payload = await response.json();
  const messageId = payload?.messages?.[0]?.id;
  if (typeof messageId !== 'string' || !messageId || messageId.length > 300) throw new Error('WhatsApp acceptance has no valid message identifier');
  return { messageId, phoneNumberId };
}
module.exports = { name: 'whatsapp', isConfigured, send };
