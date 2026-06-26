'use strict';

const mongoose = require('mongoose');

/**
 * @file notification.model.js — notifications log & inbox.
 *
 * One row = one send to ONE recipient on ONE channel. The same logical
 * notification (e.g. « examen corrigé ») thus produces several rows if it goes
 * out on multiple channels (inapp + email).
 *
 * This model serves both as:
 *   - delivery log (status, attempts, errors) for external channels;
 *   - in-app inbox (the `inapp` channel has no other storage).
 *
 * ONLY `notification.repository.js` touches this model (Postgres step 0 — see
 * POSTGRES_MIGRATION_ASSESSMENT.md §7).
 */

const CHANNELS  = ['inapp', 'email', 'whatsapp'];
// `sending` is a transient claim state: a retry worker atomically flips a row to
// it before an external send so that, under horizontal scaling, only ONE instance
// delivers a given row. A stale `sending` (dead worker) is swept back to `failed`.
const STATUSES  = ['pending', 'sending', 'sent', 'failed', 'skipped', 'read'];

// Aligned with userPreferences.userModel — identifies the recipient type.
const RECIPIENT_MODELS = [
  'Admin', 'Director', 'Campus', 'Teacher',
  'Student', 'Parent', 'Mentor', 'Staff', 'Partner',
];

const notificationSchema = new mongoose.Schema(
  {
    // ── Recipient & campus isolation ──────────────────────────────────────────
    recipientId:    { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    recipientModel: { type: String, enum: RECIPIENT_MODELS, required: true },
    schoolCampus:   { type: mongoose.Schema.Types.ObjectId, ref: 'Campus', default: null, index: true },

    // ── Routing ───────────────────────────────────────────────────────────────
    channel:  { type: String, enum: CHANNELS, required: true },
    template: { type: String, required: true, trim: true }, // template key
    locale:   { type: String, default: 'en' },
    data:     { type: mongoose.Schema.Types.Mixed, default: {} }, // render variables (re-render on retry)

    // ── Rendered content (snapshot at send time) ──────────────────────────────
    subject: { type: String, default: null }, // title (email/inapp)
    body:    { type: String, default: '' },    // rendered text body
    to:      { type: String, default: null },  // email or phone; null for inapp

    // ── Delivery state ────────────────────────────────────────────────────────
    status:      { type: String, enum: STATUSES, default: 'pending', index: true },
    attempts:    { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    lastError:   { type: String, default: null },
    sentAt:      { type: Date, default: null },
    readAt:      { type: Date, default: null },
    // Set when a worker atomically claims this row for sending; used to detect and
    // requeue rows abandoned by a dead worker (status stuck at `sending`).
    workerClaimedAt: { type: Date, default: null },

    // Optional grouping key (deduplication / threading by the caller).
    groupKey: { type: String, default: null },
  },
  { timestamps: true }
);

// In-app inbox: a recipient's unread messages (badge + list).
notificationSchema.index({ recipientId: 1, channel: 1, readAt: 1, createdAt: -1 });
// Retry worker: external sends to replay.
notificationSchema.index({ status: 1, channel: 1, attempts: 1 });

notificationSchema.statics.CHANNELS         = CHANNELS;
notificationSchema.statics.STATUSES         = STATUSES;
notificationSchema.statics.RECIPIENT_MODELS = RECIPIENT_MODELS;

module.exports = mongoose.model('Notification', notificationSchema);
