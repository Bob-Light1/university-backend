'use strict';

/**
 * @file notification.service.js — public API of the notifications foundation.
 *
 * This is the ONLY entry point for the other modules:
 *   require('../notification').service.notify({ ... })
 *
 * Responsibilities:
 *   - render a template per channel/locale (templates/index.js);
 *   - persist one Notification row per channel (repository);
 *   - attempt delivery of external channels best-effort (never throws);
 *   - expose the in-app inbox + the admin log + the retry.
 *
 * Decoupling: the caller provides the recipient's contact details (email/phone)
 * — the foundation NEVER queries the models of other modules (facade §3).
 */

const repo      = require('./notification.repository');
const channels  = require('./channels');
const templates = require('./templates');
const config    = require('../../shared/configs/general.config');

const Notification = require('./models/notification.model');
const CHANNELS = Notification.CHANNELS;

// Contact detail required per channel (inapp has none).
const contactFor = (channel, recipient) => {
  if (channel === 'email')    return recipient.email || null;
  if (channel === 'whatsapp') return recipient.phone || null;
  return null;
};

/**
 * Sends a multi-channel notification to a recipient.
 *
 * @param {Object} params
 * @param {Object} params.recipient   { id, model, email?, phone?, campusId?, locale?, prefs? }
 *   `prefs` ({ inapp, email, whatsapp }) — when supplied, external channels the
 *   recipient opted out of are dropped (in-app is never gated). Transactional
 *   emitters omit it so their delivery is never suppressed.
 * @param {string[]} [params.channels] subset of ['inapp','email','whatsapp'] (default ['inapp'])
 * @param {string} params.template     template key (see templates/index.js)
 * @param {Object} [params.data]       render variables
 * @param {string} [params.locale]     overrides the recipient's locale
 * @param {string} [params.groupKey]   optional grouping key
 * @returns {Promise<Object[]>} the created notifications (lean rows enriched with the status)
 */
async function notify({ recipient, channels: chans, template, data = {}, locale, groupKey = null }) {
  if (!recipient || !recipient.id || !recipient.model) {
    throw new Error('notify: recipient { id, model } is required');
  }
  if (!template || !templates.has(template)) {
    throw new Error(`notify: unknown template '${template}'`);
  }

  let requested = (Array.isArray(chans) && chans.length ? chans : ['inapp'])
    .filter((c) => CHANNELS.includes(c));
  if (!requested.length) throw new Error('notify: no valid channel requested');

  // Honour the recipient's notification preferences when the caller supplies them.
  // Per the facade rule (§3) the foundation never queries the recipient's model —
  // the emitter passes `prefs` in alongside the contact details. The in-app inbox
  // is the baseline channel and is NEVER gated; only external channels (email /
  // whatsapp) can be opted out of. Transactional emitters omit `prefs` on purpose.
  const prefs = recipient.prefs;
  if (prefs && typeof prefs === 'object') {
    requested = requested.filter((c) => c === 'inapp' || prefs[c] !== false);
    if (!requested.length) requested = ['inapp']; // always keep an inbox copy
  }

  const useLocale = locale || recipient.locale || templates.DEFAULT_LOCALE;
  const maxAttempts = config.notification.maxAttempts;

  // 1) Build + persist one row per channel (snapshot of the render).
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

  // 2) Deliver (best-effort, never throws to the caller).
  await Promise.all(created.map((doc) => deliver(doc)));

  return created.map((d) => (typeof d.toObject === 'function' ? d.toObject() : d));
}

/**
 * Attempts delivery of ONE row and updates its status. Never throws.
 * @param {Object} doc  Notification document/lean (must have _id, channel, to, subject, body)
 */
async function deliver(doc) {
  const channel = channels.get(doc.channel);
  try {
    if (!channel) {
      await repo.markSkipped(doc._id, `Unknown channel '${doc.channel}'`);
      return 'skipped';
    }
    // in-app: persistence is enough → sent. External: skip if not configured.
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

// ── In-app inbox (consumed by the controllers) ───────────────────────────────

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

// ── Admin log + manual retry ──────────────────────────────────────────────────

const getLog = ({ campusFilter, channel, status, recipientId, search, page = 1, limit = 20 }) => {
  const skip = (Math.max(1, page) - 1) * limit;
  return repo.paginateLog({ campusFilter, channel, status, recipientId, search, skip, limit });
};

/**
 * Manually replays a send (admin). Idempotent on terminal states: an already
 * delivered (`sent`/`read`) row is NOT re-sent, preventing duplicate emails /
 * WhatsApp messages from an accidental double click.
 * @returns {Promise<string>} resulting status
 */
const retryOne = async (id) => {
  const doc = await repo.findById(id);
  if (!doc) throw new Error('Notification not found');
  if (doc.channel === 'inapp') return doc.status === 'read' ? 'read' : 'sent';
  if (doc.status === 'sent' || doc.status === 'read') return doc.status;
  // Atomic claim so a manual replay never races the cron (or another admin) on the
  // same row. A null claim means the row is already in flight or terminal.
  const claimed = await repo.claimForRetry(id);
  if (!claimed) {
    const current = await repo.findById(id);
    return current ? current.status : 'sent';
  }
  return deliver(claimed);
};

// ── Cron: flush pending / recoverable-failure external sends ───────────────────

// In-process re-entrancy guard: cheap protection against a batch outlasting the
// cron interval within ONE process (node-cron does not serialize runs). The
// cross-instance guarantee comes from the per-row atomic claim below.
let retryJobRunning = false;

// A row stuck in `sending` longer than this was abandoned by a dead worker and is
// requeued to `failed` so it can be retried. Override via env if sends are slow.
const STALE_CLAIM_MS = parseInt(process.env.NOTIFICATION_CLAIM_STALE_MS || String(5 * 60 * 1000), 10);

const runRetryJob = async () => {
  if (retryJobRunning) {
    console.warn('📨 [notifications] retry skipped: previous run still in progress');
    return { processed: 0, sent: 0, failed: 0, skipped: 0, skippedRun: true };
  }
  retryJobRunning = true;
  try {
    // 1) Recover rows abandoned mid-send by a dead worker (status stuck at `sending`).
    await repo.requeueStaleSending(new Date(Date.now() - STALE_CLAIM_MS));

    // 2) Claim + deliver. Under horizontal scaling, only the instance that wins the
    //    atomic claim delivers a given row; the others see null and skip it, so no
    //    duplicate email / WhatsApp is ever sent.
    const candidates = await repo.findDeliverable(50);
    let sent = 0, failed = 0, skipped = 0, processed = 0;
    for (const cand of candidates) {
      const doc = await repo.claimForSend(cand._id);
      if (!doc) continue; // another instance already claimed this row
      processed += 1;
      const r = await deliver(doc);
      if (r === 'sent') sent += 1;
      else if (r === 'failed') failed += 1;
      else skipped += 1;
    }
    if (processed) {
      console.log(`📨 [notifications] retry: ${sent} sent, ${failed} failed, ${skipped} skipped`);
    }
    return { processed, sent, failed, skipped };
  } finally {
    retryJobRunning = false;
  }
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
