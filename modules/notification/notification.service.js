'use strict';

/**
 * @file notification.service.js — API publique du socle notifications.
 *
 * C'est le SEUL point d'entrée des autres modules :
 *   require('../notification').service.notify({ ... })
 *
 * Responsabilités :
 *   - rendre un template par canal/locale (templates/index.js) ;
 *   - persister une ligne Notification par canal (repository) ;
 *   - tenter la livraison des canaux externes en best-effort (jamais throw) ;
 *   - exposer la boîte de réception in-app + le journal admin + le retry.
 *
 * Découplage : l'appelant fournit les coordonnées du destinataire (email/phone)
 * — le socle n'interroge JAMAIS les models des autres modules (façade §3).
 */

const repo      = require('./notification.repository');
const channels  = require('./channels');
const templates = require('./templates');
const config    = require('../../shared/configs/general.config');

const Notification = require('./models/notification.model');
const CHANNELS = Notification.CHANNELS;

// Coordonnée requise par canal (inapp n'en a pas).
const contactFor = (channel, recipient) => {
  if (channel === 'email')    return recipient.email || null;
  if (channel === 'whatsapp') return recipient.phone || null;
  return null;
};

/**
 * Envoie une notification multi-canal à un destinataire.
 *
 * @param {Object} params
 * @param {Object} params.recipient   { id, model, email?, phone?, campusId?, locale? }
 * @param {string[]} [params.channels] sous-ensemble de ['inapp','email','whatsapp'] (défaut ['inapp'])
 * @param {string} params.template     clé de template (voir templates/index.js)
 * @param {Object} [params.data]       variables de rendu
 * @param {string} [params.locale]     surcharge la locale du destinataire
 * @param {string} [params.groupKey]   clé de regroupement optionnelle
 * @returns {Promise<Object[]>} les notifications créées (lignes lean enrichies du statut)
 */
async function notify({ recipient, channels: chans, template, data = {}, locale, groupKey = null }) {
  if (!recipient || !recipient.id || !recipient.model) {
    throw new Error('notify: recipient { id, model } is required');
  }
  if (!template || !templates.has(template)) {
    throw new Error(`notify: unknown template '${template}'`);
  }

  const requested = (Array.isArray(chans) && chans.length ? chans : ['inapp'])
    .filter((c) => CHANNELS.includes(c));
  if (!requested.length) throw new Error('notify: no valid channel requested');

  const useLocale = locale || recipient.locale || templates.DEFAULT_LOCALE;
  const maxAttempts = config.notification.maxAttempts;

  // 1) Construire + persister une ligne par canal (snapshot du rendu).
  const rows = requested.map((channel) => {
    const { subject, body } = templates.render(template, channel, data, useLocale);
    return {
      recipientId:    recipient.id,
      recipientModel: recipient.model,
      schoolCampus:   recipient.campusId || null,
      channel,
      template,
      locale: useLocale,
      data,
      subject,
      body,
      to: contactFor(channel, recipient),
      status: 'pending',
      attempts: 0,
      maxAttempts,
      groupKey,
    };
  });

  const created = await repo.createMany(rows);

  // 2) Livrer (best-effort, jamais throw vers l'appelant).
  await Promise.all(created.map((doc) => deliver(doc)));

  return created.map((d) => (typeof d.toObject === 'function' ? d.toObject() : d));
}

/**
 * Tente la livraison d'UNE ligne et met à jour son statut. Ne lève jamais.
 * @param {Object} doc  document/lean Notification (doit avoir _id, channel, to, subject, body)
 */
async function deliver(doc) {
  const channel = channels.get(doc.channel);
  try {
    if (!channel) {
      await repo.markSkipped(doc._id, `Unknown channel '${doc.channel}'`);
      return 'skipped';
    }
    // in-app : la persistance suffit → sent. Externes : skip si non configuré.
    if (doc.channel !== 'inapp' && !channel.isConfigured()) {
      await repo.markSkipped(doc._id, `Channel '${doc.channel}' not configured`);
      return 'skipped';
    }
    if (doc.channel !== 'inapp' && !doc.to) {
      await repo.markSkipped(doc._id, `No ${doc.channel} address for recipient`);
      return 'skipped';
    }
    await channel.send({ to: doc.to, subject: doc.subject, body: doc.body });
    await repo.markSent(doc._id);
    return 'sent';
  } catch (err) {
    await repo.markFailed(doc._id, err.message || String(err));
    return 'failed';
  }
}

// ── Boîte de réception in-app (consommée par les controllers) ─────────────────

const getInbox = async ({ recipientId, unreadOnly = false, page = 1, limit = 20 }) => {
  const skip = (Math.max(1, page) - 1) * limit;
  const [data, total] = await Promise.all([
    repo.findInbox({ recipientId, unreadOnly, skip, limit }),
    repo.countInbox({ recipientId, unreadOnly }),
  ]);
  return { data, total, page: Math.max(1, page), limit };
};

const getUnreadCount = (recipientId) => repo.countUnread(recipientId);
const markRead       = async (id, recipientId) => (await repo.markRead(id, recipientId)).modifiedCount > 0;
const markAllRead    = async (recipientId) => (await repo.markAllRead(recipientId)).modifiedCount;

// ── Journal admin + retry manuel ──────────────────────────────────────────────

const getLog = ({ campusFilter, channel, status, recipientId, search, page = 1, limit = 20 }) => {
  const skip = (Math.max(1, page) - 1) * limit;
  return repo.paginateLog({ campusFilter, channel, status, recipientId, search, skip, limit });
};

/** Rejoue manuellement un envoi (admin). @returns {Promise<string>} statut résultant */
const retryOne = async (id) => {
  const doc = await repo.findById(id);
  if (!doc) throw new Error('Notification not found');
  if (doc.channel === 'inapp') return 'sent';
  return deliver(doc);
};

// ── Cron : flush des envois externes en attente / en échec récupérable ─────────

const runRetryJob = async () => {
  const batch = await repo.findDeliverable(50);
  let sent = 0, failed = 0, skipped = 0;
  for (const doc of batch) {
    const r = await deliver(doc);
    if (r === 'sent') sent += 1;
    else if (r === 'failed') failed += 1;
    else skipped += 1;
  }
  if (batch.length) {
    console.log(`📨 [notifications] retry: ${sent} sent, ${failed} failed, ${skipped} skipped`);
  }
  return { processed: batch.length, sent, failed, skipped };
};

module.exports = {
  notify,
  deliver,
  getInbox,
  getUnreadCount,
  markRead,
  markAllRead,
  getLog,
  retryOne,
  runRetryJob,
  CHANNELS,
  TEMPLATE_KEYS: templates.TEMPLATE_KEYS,
};
