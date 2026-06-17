'use strict';

const mongoose = require('mongoose');

/**
 * @file notification.model.js — journal & boîte de réception des notifications.
 *
 * Une ligne = un envoi vers UN destinataire sur UN canal. La même notification
 * logique (ex. « examen corrigé ») produit donc plusieurs lignes si elle part
 * sur plusieurs canaux (inapp + email).
 *
 * Ce model sert à la fois de :
 *   - journal de livraison (statut, tentatives, erreurs) pour les canaux externes ;
 *   - boîte de réception in-app (le canal `inapp` n'a pas d'autre stockage).
 *
 * SEUL `notification.repository.js` touche ce model (étape 0 Postgres — voir
 * POSTGRES_MIGRATION_ASSESSMENT.md §7).
 */

const CHANNELS  = ['inapp', 'email', 'whatsapp'];
const STATUSES  = ['pending', 'sent', 'failed', 'skipped', 'read'];

// Aligné sur userPreferences.userModel — identifie le type de destinataire.
const RECIPIENT_MODELS = [
  'Admin', 'Director', 'Campus', 'Teacher',
  'Student', 'Parent', 'Mentor', 'Staff', 'Partner',
];

const notificationSchema = new mongoose.Schema(
  {
    // ── Destinataire & isolation campus ───────────────────────────────────────
    recipientId:    { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    recipientModel: { type: String, enum: RECIPIENT_MODELS, required: true },
    schoolCampus:   { type: mongoose.Schema.Types.ObjectId, ref: 'Campus', default: null, index: true },

    // ── Acheminement ──────────────────────────────────────────────────────────
    channel:  { type: String, enum: CHANNELS, required: true },
    template: { type: String, required: true, trim: true }, // clé de template
    locale:   { type: String, default: 'en' },
    data:     { type: mongoose.Schema.Types.Mixed, default: {} }, // variables de rendu (re-render au retry)

    // ── Contenu rendu (instantané au moment de l'envoi) ───────────────────────
    subject: { type: String, default: null }, // titre (email/inapp)
    body:    { type: String, default: '' },    // corps texte rendu
    to:      { type: String, default: null },  // email ou téléphone ; null pour inapp

    // ── État de livraison ─────────────────────────────────────────────────────
    status:      { type: String, enum: STATUSES, default: 'pending', index: true },
    attempts:    { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    lastError:   { type: String, default: null },
    sentAt:      { type: Date, default: null },
    readAt:      { type: Date, default: null },

    // Clé de regroupement optionnelle (déduplication / threading par l'appelant).
    groupKey: { type: String, default: null },
  },
  { timestamps: true }
);

// Boîte de réception in-app : non lus d'un destinataire (badge + liste).
notificationSchema.index({ recipientId: 1, channel: 1, readAt: 1, createdAt: -1 });
// Worker de retry : envois externes à rejouer.
notificationSchema.index({ status: 1, channel: 1, attempts: 1 });

notificationSchema.statics.CHANNELS         = CHANNELS;
notificationSchema.statics.STATUSES         = STATUSES;
notificationSchema.statics.RECIPIENT_MODELS = RECIPIENT_MODELS;

module.exports = mongoose.model('Notification', notificationSchema);
