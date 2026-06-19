'use strict';

/**
 * @file inapp.channel.js — in-app notification channel.
 *
 * In-app « delivery » is persistence: the Notification row IS the message in
 * the inbox. There is therefore no external call — the channel is always
 * « configured » and the send succeeds as soon as the row exists.
 */

const isConfigured = () => true;

// The document is already created by the service; nothing to send.
const send = async () => ({ ok: true });

module.exports = { name: 'inapp', isConfigured, send };
