'use strict';

/**
 * @file notification.repository.js — couche de persistance du socle notifications.
 *
 * SEUL fichier du module autorisé à toucher le model Notification. Le service et
 * les controllers passent par lui. Étape 0 Postgres — voir
 * POSTGRES_MIGRATION_ASSESSMENT.md §7.
 *
 * Lectures en `.lean()`. Les mises à jour de statut sont des opérateurs atomiques
 * (`updateOne`/`updateMany`) — pas de hook métier sur ce model à préserver.
 */

const Notification    = require('./models/notification.model');
const { escapeRegex } = require('../../shared/utils/validation-helpers');

// ── Écritures ───────────────────────────────────────────────────────────────

const createMany = (rows) => Notification.insertMany(rows);

const markSent = (id) =>
  Notification.updateOne(
    { _id: id },
    { $set: { status: 'sent', sentAt: new Date(), lastError: null }, $inc: { attempts: 1 } }
  );

const markSkipped = (id, reason) =>
  Notification.updateOne(
    { _id: id },
    { $set: { status: 'skipped', lastError: reason || null } }
  );

/**
 * Marque l'échec d'un envoi : `failed` tant qu'il reste des tentatives sous le
 * plafond, sinon on laisse `failed` (le worker ne le reprendra plus car
 * attempts >= maxAttempts).
 */
const markFailed = (id, error) =>
  Notification.updateOne(
    { _id: id },
    { $set: { status: 'failed', lastError: String(error).slice(0, 500) }, $inc: { attempts: 1 } }
  );

// ── Boîte de réception in-app ─────────────────────────────────────────────────

const findInbox = ({ recipientId, unreadOnly, skip = 0, limit = 20 }) => {
  const filter = { recipientId, channel: 'inapp' };
  if (unreadOnly) filter.readAt = null;
  return Notification.find(filter)
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

/** Marque lu un message in-app appartenant bien au destinataire (anti-IDOR). */
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

// ── Worker de retry ───────────────────────────────────────────────────────────

/**
 * Envois externes (email/whatsapp) en attente ou en échec récupérable.
 * `pending` = jamais tenté (ex. crash avant flush) ; `failed` avec
 * attempts < maxAttempts = à rejouer.
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

const findById = (id) => Notification.findById(id).lean();

// ── Journal admin ─────────────────────────────────────────────────────────────

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
  findById,
  paginateLog,
};
