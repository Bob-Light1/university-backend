'use strict';

/**
 * @file notification.repository.js — persistence layer of the notifications foundation.
 *
 * The ONLY file in the module allowed to touch the Notification model. The service
 * and the controllers go through it. Postgres step 0 — see
 * POSTGRES_MIGRATION_ASSESSMENT.md §7.
 *
 * Reads use `.lean()`. Status updates are atomic operators
 * (`updateOne`/`updateMany`) — no business hook on this model to preserve.
 */

const Notification    = require('./models/notification.model');
const { escapeRegex } = require('../../shared/utils/validation-helpers');
const { DELIVERY, DELIVERY_RANK } = require('../../shared/constants/whatsapp.constants');

// ── Writes ────────────────────────────────────────────────────────────────────

const createMany = (rows, options = undefined) => options
  ? Notification.insertMany(rows, options)
  : Notification.insertMany(rows);

const markSent = (id) =>
  Notification.updateOne(
    { _id: id },
    { $set: { status: 'sent', sentAt: new Date(), lastError: null, workerClaimedAt: null }, $inc: { attempts: 1 } }
  );

const markSkipped = (id, reason) =>
  Notification.updateOne(
    { _id: id },
    { $set: { status: 'skipped', lastError: reason || null, workerClaimedAt: null } }
  );

/**
 * Marks a send as failed: `failed` as long as attempts remain under the cap,
 * otherwise we leave it `failed` (the worker won't pick it up again since
 * attempts >= maxAttempts).
 */
const markFailed = (id, error) =>
  Notification.updateOne(
    { _id: id },
    { $set: { status: 'failed', lastError: String(error).slice(0, 500), workerClaimedAt: null }, $inc: { attempts: 1 } }
  );

// ── In-app inbox ──────────────────────────────────────────────────────────────

const findInbox = ({ recipientId, unreadOnly, skip = 0, limit = 20 }) => {
  const filter = { recipientId, channel: 'inapp' };
  if (unreadOnly) filter.readAt = null;
  return Notification.find(filter)
    .select('+privatePayload')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
};

const countInbox = ({ recipientId, unreadOnly }) => {
  const filter = { recipientId, channel: 'inapp' };
  if (unreadOnly) filter.readAt = null;
  return Notification.countDocuments(filter);
};

const countUnread = (recipientId) =>
  Notification.countDocuments({ recipientId, channel: 'inapp', readAt: null });

/** Marks read an in-app message that does belong to the recipient (anti-IDOR). */
const markRead = (id, recipientId) =>
  Notification.updateOne(
    { _id: id, recipientId, channel: 'inapp', readAt: null },
    { $set: { status: 'read', readAt: new Date() } }
  );

const markAllRead = (recipientId) =>
  Notification.updateMany(
    { recipientId, channel: 'inapp', readAt: null },
    { $set: { status: 'read', readAt: new Date() } }
  );

// ── Retry worker ────────────────────────────────────────────────────────────────

/**
 * External sends (email/whatsapp) pending or in recoverable failure.
 * `pending` = never attempted (e.g. crash before flush); `failed` with
 * attempts < maxAttempts = to replay.
 */
const findDeliverable = (limit = 50) =>
  Notification.find({
    channel: { $in: ['email', 'whatsapp'] },
    status:  { $in: ['pending', 'failed'] },
    $expr:   { $lt: ['$attempts', '$maxAttempts'] },
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

/**
 * Atomically claims a deliverable row for the retry worker (`pending`/`failed`
 * under the attempt cap → `sending`). Returns the claimed doc, or null if another
 * instance already took it — this is what makes the cron multi-instance safe.
 */
const claimForSend = (id) =>
  Notification.findOneAndUpdate(
    {
      _id: id,
      channel: { $in: ['email', 'whatsapp'] },
      status:  { $in: ['pending', 'failed'] },
      $expr:   { $lt: ['$attempts', '$maxAttempts'] },
    },
    { $set: { status: 'sending', workerClaimedAt: new Date() } },
    { new: true }
  ).select('+privatePayload').lean();

/**
 * Atomically claims a row for a MANUAL admin replay (`pending`/`failed`/`skipped`
 * → `sending`, ignoring the attempt cap). Excludes `sending` (already in flight)
 * and terminal `sent`/`read`, so a manual retry never races the cron on a row.
 */
const claimForRetry = (id, campusFilter = {}) =>
  Notification.findOneAndUpdate(
    { ...campusFilter, _id: id, channel: { $in: ['email', 'whatsapp'] }, status: { $in: ['pending', 'failed', 'skipped'] } },
    { $set: { status: 'sending', workerClaimedAt: new Date() } },
    { new: true }
  ).select('+privatePayload').lean();

/** Requeues rows abandoned mid-send by a dead worker (`sending` older than `staleBefore` → `failed`). */
const requeueStaleSending = (staleBefore) =>
  Notification.updateMany(
    { status: 'sending', workerClaimedAt: { $lt: staleBefore } },
    { $set: { status: 'failed', workerClaimedAt: null } }
  );

const findById = (id, campusFilter = {}) => Notification.findOne({ ...campusFilter, _id: id }).lean();

/** Fence every possible provider request, even after timeout or process death. */
const startWhatsappSubmission = (id, phoneNumberId, phone) => Notification.updateOne(
  { _id: id, channel: 'whatsapp', 'whatsapp.submissionStartedAt': null },
  { $set: { to: phone, 'whatsapp.submissionStartedAt': new Date(), 'whatsapp.phoneNumberId': phoneNumberId,
    'whatsapp.deliveryStatus': DELIVERY.UNKNOWN, 'whatsapp.deliveryRank': DELIVERY_RANK[DELIVERY.UNKNOWN] } }
);

/** Provider acceptance is distinct from delivery; do not overwrite a racing callback. */
const acceptWhatsapp = async (id, messageId) => {
  await Notification.updateOne({ _id: id, $or: [{ 'whatsapp.messageId': null }, { 'whatsapp.messageId': messageId }] },
    { $set: { 'whatsapp.messageId': messageId, status: 'sent', sentAt: new Date(), lastError: null, workerClaimedAt: null }, $inc: { attempts: 1 } });
  await Notification.updateOne({ _id: id, 'whatsapp.deliveryRank': { $lt: DELIVERY_RANK[DELIVERY.ACCEPTED] } },
    { $set: { 'whatsapp.deliveryStatus': DELIVERY.ACCEPTED, 'whatsapp.deliveryRank': DELIVERY_RANK[DELIVERY.ACCEPTED] } });
};

/** A signed callback must match sender, recipient, correlation and message identity. */
const recordWhatsappStatus = ({ notificationId, messageId, phoneNumberId, phone, status, rank, at }) => {
  const identity = notificationId
    ? { _id: notificationId, $or: [{ 'whatsapp.messageId': null }, { 'whatsapp.messageId': messageId }] }
    : { 'whatsapp.messageId': messageId };
  return Notification.updateOne({
    ...identity, channel: 'whatsapp', to: phone,
    'whatsapp.phoneNumberId': phoneNumberId, 'whatsapp.submissionStartedAt': { $ne: null },
    'whatsapp.deliveryRank': { $lt: rank },
  }, { $set: { 'whatsapp.messageId': messageId, 'whatsapp.deliveryStatus': status,
    'whatsapp.deliveryRank': rank, 'whatsapp.statusAt': at, status: 'sent', workerClaimedAt: null } });
};

// ── Admin log ─────────────────────────────────────────────────────────────────

const paginateLog = async ({ campusFilter = {}, channel, status, recipientId, search, skip = 0, limit = 20 }) => {
  const filter = { ...campusFilter };
  if (channel)     filter.channel     = channel;
  if (status)      filter.status      = status;
  if (recipientId) filter.recipientId = recipientId;
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ subject: rx }, { body: rx }, { to: rx }, { template: rx }];
  }

  const [data, total] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Notification.countDocuments(filter),
  ]);
  return { data, total };
};

module.exports = {
  createMany,
  markSent,
  markSkipped,
  markFailed,
  findInbox,
  countInbox,
  countUnread,
  markRead,
  markAllRead,
  findDeliverable,
  claimForSend,
  claimForRetry,
  requeueStaleSending,
  findById,
  paginateLog,
  startWhatsappSubmission,
  acceptWhatsapp,
  recordWhatsappStatus,
};
